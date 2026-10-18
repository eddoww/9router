import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runTransform(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "codex",
      null,
      null,
      "gpt-5.5",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

describe("OpenAI Responses streaming termination", () => {
  it.each([
    { type: "internal_error", code: null, message: "response protection is unavailable" },
    { type: "invalid_request_error", code: "context_length_exceeded", message: "Context is too long" },
  ])("preserves upstream error details in a terminal response.failed: %j", async (error) => {
    const output = await runTransform(`event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`);
    const failure = output.split("\n").filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6))).find(item => item.type === "response.failed");
    expect(failure?.response.error).toEqual(error);
    expect(output).not.toContain("stream closed before response.completed");
    expect(output.match(/event: response.failed/g)).toHaveLength(1);
  });

  it("emits a response.failed event when a Responses stream closes before a terminal event", async () => {
    const output = await runTransform([
      `event: response.created`,
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      `event: response.output_text.delta`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.failed");
    expect(output).toContain('"type":"response.failed"');
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("does not add response.failed when a Responses stream already completed", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).not.toContain("event: response.failed");
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("does not add response.failed when a Responses stream sends response.done", async () => {
    const output = await runTransform([
      `event: response.done`,
      `data: ${JSON.stringify({ type: "response.done", response: { id: "resp_test" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.done");
    expect(output).not.toContain("event: response.failed");
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("emits response.failed before DONE when a Responses stream sends DONE without a terminal event", async () => {
    const output = await runTransform([
      `event: response.created`,
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(output.indexOf("event: response.failed")).toBeLessThan(output.indexOf("data: [DONE]"));
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).not.toContain("data: null");
  });
});
