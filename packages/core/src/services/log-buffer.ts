import { Effect, Ref } from "effect";
import { LogBufferConfigurationError, LogBufferQueryError } from "../domain/errors.ts";

export const defaultLogBufferMaxSize = 1_000_000;

export interface LogBufferOptions {
  readonly maxSize?: number;
}

export type LogBufferOrder = "asc" | "desc";

export interface LogBufferQueryOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly order?: LogBufferOrder;
  readonly since?: number;
  readonly until?: number;
}

export interface LogBufferReadResult {
  readonly lines: readonly string[];
  readonly totalLines: number;
  readonly filteredLines: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly order: LogBufferOrder;
}

export interface LogBufferSearchMatch {
  readonly lineNumber: number;
  readonly text: string;
}

export interface LogBufferSearchResult {
  readonly matches: readonly LogBufferSearchMatch[];
  readonly totalMatches: number;
  readonly filteredLines: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly order: LogBufferOrder;
}

interface TimestampMark {
  readonly lineIndex: number;
  readonly timestamp: number;
}

interface BufferState {
  readonly text: string;
  readonly headLineOffset: number;
  readonly timestampMarks: readonly TimestampMark[];
}

export interface LogBufferInstance {
  readonly taskId: string;
  readonly maxSize: number;
  readonly append: (data: string) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<string>;
  readonly read: (
    options?: LogBufferQueryOptions,
  ) => Effect.Effect<LogBufferReadResult, LogBufferQueryError>;
  readonly search: (
    pattern: RegExp,
    options?: LogBufferQueryOptions,
  ) => Effect.Effect<LogBufferSearchResult, LogBufferQueryError>;
  readonly clear: () => Effect.Effect<void>;
  readonly lastLine: Effect.Effect<string | undefined>;
  readonly lineCount: Effect.Effect<number>;
  readonly byteLength: Effect.Effect<number>;
}

interface NormalizedQueryOptions {
  readonly offset: number;
  readonly limit: number | undefined;
  readonly order: LogBufferOrder;
  readonly since: number | undefined;
  readonly until: number | undefined;
}

interface Page<T> {
  readonly items: readonly T[];
  readonly startIndex: number;
  readonly hasMore: boolean;
  readonly resultOffset: number;
}

const isSafeNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const isSafePositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isLogBufferOrder = (value: string): value is LogBufferOrder =>
  value === "asc" || value === "desc";

const emptyBufferState: BufferState = {
  text: "",
  headLineOffset: 0,
  timestampMarks: [],
};

const countTrimmedLineBreaks = (text: string, endExclusive: number): number => {
  let count = 0;
  let index = 0;

  while (index < endExclusive) {
    const current = text[index];
    if (current === "\n") {
      count += 1;
      index += 1;
      continue;
    }

    if (current === "\r" && text[index + 1] === "\n") {
      count += 1;
      index += 2;
      continue;
    }

    index += 1;
  }

  return count;
};

const getFirstVisibleLineIndex = (state: BufferState): number => state.headLineOffset + 1;

const getAppendStartLineIndex = (state: BufferState): number => {
  const lineCount = splitLines(state.text).length;
  if (lineCount === 0) {
    return getFirstVisibleLineIndex(state);
  }

  return state.text.endsWith("\n")
    ? state.headLineOffset + lineCount + 1
    : state.headLineOffset + lineCount;
};

const rebaseTimestampMarks = (
  marks: readonly TimestampMark[],
  firstVisibleLineIndex: number,
): readonly TimestampMark[] => {
  let inheritedMark: TimestampMark | undefined;
  const retained: TimestampMark[] = [];

  for (const mark of marks) {
    if (mark.lineIndex < firstVisibleLineIndex) {
      inheritedMark = mark;
      continue;
    }

    retained.push(mark);
  }

  if (inheritedMark && retained[0]?.lineIndex !== firstVisibleLineIndex) {
    retained.unshift({
      lineIndex: firstVisibleLineIndex,
      timestamp: inheritedMark.timestamp,
    });
  }

  return retained;
};

const trimStateToMaxSize = (state: BufferState, maxSize: number): BufferState => {
  if (state.text.length <= maxSize) {
    return state;
  }

  const cutPoint = state.text.length - maxSize;
  const trimmedLineBreaks = countTrimmedLineBreaks(state.text, cutPoint);
  const headLineOffset = state.headLineOffset + trimmedLineBreaks;
  const text = state.text.slice(cutPoint);
  if (text.length === 0) {
    return {
      text,
      headLineOffset,
      timestampMarks: [],
    };
  }

  const firstVisibleLineIndex = headLineOffset + 1;
  return {
    text,
    headLineOffset,
    timestampMarks: rebaseTimestampMarks(state.timestampMarks, firstVisibleLineIndex),
  };
};

const splitLines = (buffer: string): readonly string[] => {
  if (buffer.length === 0) {
    return [];
  }

  const lines = buffer.split(/\r?\n/);

  if (buffer.endsWith("\n")) {
    lines.pop();
  }

  return lines;
};

const getLastLine = (text: string): string | undefined => {
  if (text.length === 0) {
    return undefined;
  }

  const trailingTrimmed = text.endsWith("\n")
    ? text.replace(/[\r\n]+$/, "")
    : text.replace(/\r$/, "");
  if (trailingTrimmed.length === 0) {
    return undefined;
  }

  const lastNewlineIndex = Math.max(
    trailingTrimmed.lastIndexOf("\n"),
    trailingTrimmed.lastIndexOf("\r"),
  );

  return lastNewlineIndex === -1 ? trailingTrimmed : trailingTrimmed.slice(lastNewlineIndex + 1);
};

const formatLine = (lineNumber: number, text: string): string => `${lineNumber}: ${text}`;

const paginateAscending = <T>(items: readonly T[], options: NormalizedQueryOptions): Page<T> => {
  const startIndex = Math.min(options.offset, items.length);
  const endIndex =
    options.limit === undefined ? items.length : Math.min(startIndex + options.limit, items.length);

  return {
    items: items.slice(startIndex, endIndex),
    startIndex,
    hasMore: endIndex < items.length,
    resultOffset: startIndex,
  };
};

const paginateDescending = <T>(items: readonly T[], options: NormalizedQueryOptions): Page<T> => {
  const endIndex = Math.max(0, items.length - options.offset);
  const startIndex = options.limit === undefined ? 0 : Math.max(0, endIndex - options.limit);

  return {
    items: items.slice(startIndex, endIndex).reverse(),
    startIndex,
    hasMore: startIndex > 0,
    resultOffset: options.offset,
  };
};

const paginate = <T>(items: readonly T[], options: NormalizedQueryOptions): Page<T> =>
  options.order === "desc" ? paginateDescending(items, options) : paginateAscending(items, options);

const toResultOffset = (offset: number, total: number): number => {
  if (total === 0) {
    return 0;
  }

  return Math.min(offset + 1, total + 1);
};

const validateMaxSize = (
  taskId: string,
  maxSize: number,
): Effect.Effect<number, LogBufferConfigurationError> => {
  if (isSafePositiveInteger(maxSize)) {
    return Effect.succeed(maxSize);
  }

  return Effect.fail(
    new LogBufferConfigurationError({
      taskId,
      maxSize,
      reason: "maxSize must be a positive safe integer",
    }),
  );
};

const validateQueryOptions = (
  taskId: string,
  operation: "read" | "search",
  options?: LogBufferQueryOptions,
): Effect.Effect<NormalizedQueryOptions, LogBufferQueryError> => {
  const offset = options?.offset ?? 0;
  const limit = options?.limit;
  const order = options?.order ?? "asc";
  const since = options?.since;
  const until = options?.until;

  if (!isSafeNonNegativeInteger(offset)) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit: limit ?? -1,
        reason: "offset must be a non-negative safe integer",
      }),
    );
  }

  if (limit !== undefined && !isSafeNonNegativeInteger(limit)) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit,
        reason: "limit must be a non-negative safe integer",
      }),
    );
  }

  if (!isLogBufferOrder(order)) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit: limit ?? -1,
        reason: "order must be 'asc' or 'desc'",
      }),
    );
  }

  if (since !== undefined && !Number.isSafeInteger(since)) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit: limit ?? -1,
        reason: "since must be a safe integer millisecond timestamp",
      }),
    );
  }

  if (until !== undefined && !Number.isSafeInteger(until)) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit: limit ?? -1,
        reason: "until must be a safe integer millisecond timestamp",
      }),
    );
  }

  if (since !== undefined && until !== undefined && since > until) {
    return Effect.fail(
      new LogBufferQueryError({
        taskId,
        operation,
        offset,
        limit: limit ?? -1,
        reason: "since must be less than or equal to until",
      }),
    );
  }

  return Effect.succeed({ offset, limit, order, since, until });
};

const normalizeTimestampMarks = (marks: readonly TimestampMark[]): readonly TimestampMark[] => {
  const normalized: TimestampMark[] = [];

  for (const mark of marks) {
    const last = normalized.at(-1);
    if (last?.lineIndex === mark.lineIndex) {
      normalized[normalized.length - 1] = mark;
      continue;
    }

    normalized.push(mark);
  }

  return normalized;
};

const findFirstMarkAtOrAfterTimestamp = (
  marks: readonly TimestampMark[],
  timestamp: number,
): number => {
  let low = 0;
  let high = marks.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (marks[mid]!.timestamp < timestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
};

const findLastMarkAtOrBeforeTimestamp = (
  marks: readonly TimestampMark[],
  timestamp: number,
): number => {
  let low = 0;
  let high = marks.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (marks[mid]!.timestamp <= timestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low - 1;
};

const filterLinesByTimeRange = <T extends { readonly lineNumber: number }>(
  items: readonly T[],
  state: BufferState,
  query: NormalizedQueryOptions,
): {
  readonly items: readonly T[];
  readonly filteredLines: number;
} => {
  if (items.length === 0) {
    return { items, filteredLines: 0 };
  }

  if (query.since === undefined && query.until === undefined) {
    return { items, filteredLines: items.length };
  }

  const marks = normalizeTimestampMarks(state.timestampMarks);
  if (marks.length === 0) {
    return { items: [], filteredLines: 0 };
  }

  const firstVisibleLineIndex = items[0]!.lineNumber;
  const lastVisibleLineIndex = items.at(-1)!.lineNumber;
  const startMarkIndex =
    query.since === undefined ? 0 : findFirstMarkAtOrAfterTimestamp(marks, query.since);
  const endMarkIndex =
    query.until === undefined
      ? marks.length - 1
      : findLastMarkAtOrBeforeTimestamp(marks, query.until);

  if (startMarkIndex >= marks.length || endMarkIndex < 0 || startMarkIndex > endMarkIndex) {
    return { items: [], filteredLines: 0 };
  }

  const startLineIndex = Math.max(firstVisibleLineIndex, marks[startMarkIndex]!.lineIndex);
  const endLineIndex = Math.min(
    lastVisibleLineIndex,
    (marks[endMarkIndex + 1]?.lineIndex ?? lastVisibleLineIndex + 1) - 1,
  );

  if (startLineIndex > endLineIndex) {
    return { items: [], filteredLines: 0 };
  }

  const filteredItems = items.filter(
    (item) => item.lineNumber >= startLineIndex && item.lineNumber <= endLineIndex,
  );

  return {
    items: filteredItems,
    filteredLines: endLineIndex - startLineIndex + 1,
  };
};

const buildSearchMatches = (
  items: readonly { readonly lineNumber: number; readonly text: string }[],
  pattern: RegExp,
): readonly LogBufferSearchMatch[] => {
  const matcher = new RegExp(pattern.source, pattern.flags);

  return items.flatMap(({ lineNumber, text }) => {
    matcher.lastIndex = 0;

    if (!matcher.test(text)) {
      return [];
    }

    return [{ lineNumber, text }];
  });
};

const makeInstance = (
  taskId: string,
  maxSize: number,
  bufferRef: Ref.Ref<BufferState>,
): LogBufferInstance => {
  const append = Effect.fn("LogBufferInstance.append")(function* (data: string) {
    if (data.length === 0) {
      return;
    }

    yield* Ref.update(bufferRef, (state) =>
      trimStateToMaxSize(
        {
          ...state,
          text: state.text + data,
          timestampMarks: [
            ...state.timestampMarks,
            { lineIndex: getAppendStartLineIndex(state), timestamp: Date.now() },
          ],
        },
        maxSize,
      ),
    );
  });

  const read = Effect.fn("LogBufferInstance.read")(function* (options?: LogBufferQueryOptions) {
    const query = yield* validateQueryOptions(taskId, "read", options);
    const state = yield* Ref.get(bufferRef);
    const lines = splitLines(state.text);
    const numberedLines = lines.map((text, index) => ({
      lineNumber: state.headLineOffset + index + 1,
      text,
    }));
    const filtered = filterLinesByTimeRange(numberedLines, state, query);
    const page = paginate(filtered.items, query);

    return {
      lines: page.items.map((line) => formatLine(line.lineNumber, line.text)),
      totalLines: lines.length,
      filteredLines: filtered.filteredLines,
      offset: toResultOffset(page.resultOffset, filtered.filteredLines),
      hasMore: page.hasMore,
      order: query.order,
    } satisfies LogBufferReadResult;
  });

  const search = Effect.fn("LogBufferInstance.search")(function* (
    pattern: RegExp,
    options?: LogBufferQueryOptions,
  ) {
    const query = yield* validateQueryOptions(taskId, "search", options);
    const state = yield* Ref.get(bufferRef);
    const filteredLines = filterLinesByTimeRange(
      splitLines(state.text).map((text, index) => ({
        lineNumber: state.headLineOffset + index + 1,
        text,
      })),
      state,
      query,
    );
    const matches = buildSearchMatches(filteredLines.items, pattern);
    const page = paginate(matches, query);

    return {
      matches: page.items,
      totalMatches: matches.length,
      filteredLines: filteredLines.filteredLines,
      offset: toResultOffset(page.resultOffset, matches.length),
      hasMore: page.hasMore,
      order: query.order,
    } satisfies LogBufferSearchResult;
  });

  const clear = Effect.fn("LogBufferInstance.clear")(function* () {
    yield* Ref.set(bufferRef, emptyBufferState);
  });

  return {
    taskId,
    maxSize,
    append,
    read,
    search,
    clear,
    get snapshot() {
      return Ref.get(bufferRef).pipe(Effect.map((state) => state.text));
    },
    get lastLine() {
      return Ref.get(bufferRef).pipe(Effect.map((state) => getLastLine(state.text)));
    },
    get lineCount() {
      return Ref.get(bufferRef).pipe(Effect.map((state) => splitLines(state.text).length));
    },
    get byteLength() {
      return Ref.get(bufferRef).pipe(Effect.map((state) => state.text.length));
    },
  };
};

export class LogBuffer extends Effect.Service<LogBuffer>()("@bg-tasks/LogBuffer", {
  scoped: Effect.succeed({
    make: Effect.fn("LogBuffer.make")(function* (taskId: string, options?: LogBufferOptions) {
      const maxSize = yield* validateMaxSize(taskId, options?.maxSize ?? defaultLogBufferMaxSize);
      const bufferRef = yield* Effect.acquireRelease(Ref.make(emptyBufferState), () => Effect.void);

      return makeInstance(taskId, maxSize, bufferRef);
    }),
  }),
}) {}
