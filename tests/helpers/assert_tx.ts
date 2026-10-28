import * as assert from "assert";

function describeError(err: any): string {
  return [
    err?.error?.errorCode?.code,
    err?.error?.errorMessage,
    err?.message,
    ...(err?.logs ?? []),
    ...(err?.error?.logs ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function assertTxFails(
  send: () => Promise<unknown>,
  errorName: string
): Promise<void> {
  try {
    await send();
  } catch (err: any) {
    const code = err?.error?.errorCode?.code;
    if (typeof code === "string" && code.length > 0) {
      assert.strictEqual(
        code,
        errorName,
        `期望错误码 ${errorName}，实际错误码 ${code}\n${describeError(err)}`
      );
      return;
    }
    const text = describeError(err);
    assert.ok(
      text.includes(errorName),
      `期望遇到 ${errorName}，实际错误是:\n${text}`
    );
    return;
  }
  assert.fail(`期望交易失败（${errorName}），但成功了`);
}

export function sameJson(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert.equal(left, right, `${message}\n实际: ${left}\n期望: ${right}`);
}
