import { describe, expect, test } from "bun:test";
import { Effect, Scope } from "effect";
import { LogBuffer } from "@skastr0/background-tasks-core";

const runScopedLogBuffer = <A, E>(
  program: Effect.Effect<A, E, LogBuffer | Scope.Scope>,
): Promise<A> => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(LogBuffer.Default))));

describe("LogBuffer", () => {
  test("appends data and paginates reads with line numbers", async () => {
    const result = await runScopedLogBuffer(
      Effect.gen(function* () {
        const service = yield* LogBuffer;
        const buffer = yield* service.make("task-1");
        yield* buffer.append("first\nsecond\nthird\n");
        return yield* buffer.read({ offset: 1, limit: 1 });
      }),
    );

    expect(result).toEqual({
      lines: ["2: second"],
      totalLines: 3,
      filteredLines: 3,
      offset: 2,
      hasMore: true,
      order: "asc",
    });
  });
});
