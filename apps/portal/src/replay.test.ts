import { describe, expect, it, vi } from "vitest";
import { createReplay } from "./replay";

function setup(total: number) {
  vi.useFakeTimers();
  const seen: number[] = [];
  const replay = createReplay({
    total,
    intervalMs: 1000,
    onChange: (s) => seen.push(s.shown),
  });
  return { replay, seen };
}

describe("replay", () => {
  it("starts with everything shown and not playing", () => {
    const { replay } = setup(3);
    expect(replay.state()).toEqual({ shown: 3, total: 3, playing: false });
    replay.destroy();
    vi.useRealTimers();
  });

  it("plays from the start one event per tick and stops at the end", () => {
    const { replay, seen } = setup(3);
    replay.play();
    expect(replay.state()).toEqual({ shown: 0, total: 3, playing: true });
    vi.advanceTimersByTime(1000);
    expect(replay.state().shown).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(replay.state()).toEqual({ shown: 3, total: 3, playing: false });
    vi.advanceTimersByTime(5000);
    expect(replay.state().shown).toBe(3);
    expect(seen.at(-1)).toBe(3);
    vi.useRealTimers();
  });

  it("pauses and resumes where it stopped", () => {
    const { replay } = setup(5);
    replay.play();
    vi.advanceTimersByTime(2000);
    replay.pause();
    vi.advanceTimersByTime(5000);
    expect(replay.state()).toEqual({ shown: 2, total: 5, playing: false });
    replay.toggle();
    vi.advanceTimersByTime(1000);
    expect(replay.state()).toEqual({ shown: 3, total: 5, playing: true });
    replay.destroy();
    vi.useRealTimers();
  });

  it("steps forward and back within bounds and resets", () => {
    const { replay } = setup(2);
    replay.reset();
    expect(replay.state().shown).toBe(0);
    replay.prev();
    expect(replay.state().shown).toBe(0);
    replay.next();
    replay.next();
    replay.next();
    expect(replay.state().shown).toBe(2);
    replay.prev();
    expect(replay.state().shown).toBe(1);
    vi.useRealTimers();
  });

  it("stops its timer when destroyed, and handles a run with no events", () => {
    const { replay, seen } = setup(4);
    replay.play();
    replay.destroy();
    const count = seen.length;
    vi.advanceTimersByTime(10_000);
    expect(seen.length).toBe(count);
    const empty = createReplay({
      total: 0,
      intervalMs: 1000,
      onChange: () => {},
    });
    empty.play();
    expect(empty.state()).toEqual({ shown: 0, total: 0, playing: false });
    vi.useRealTimers();
  });
});
