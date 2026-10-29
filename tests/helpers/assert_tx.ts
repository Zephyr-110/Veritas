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
        `expected error ${errorName}, got ${code}\n${describeError(err)}`
      );
      return;
    }
    const text = describeError(err);
    assert.ok(
      text.includes(errorName),
      `expected ${errorName}, got:\n${text}`
    );
    return;
  }
  assert.fail(`expected tx to fail (${errorName}), but it succeeded`);
}

export function sameJson(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert.equal(left, right, `${message}\nactual: ${left}\nexpected: ${right}`);
}
