import { describe, expect, it } from "vitest";
import {
  CHAPTERS,
  LAST_CHAPTER,
  TRUST_LEVELS,
  altitude,
  chapterFromScroll,
  handoff,
  lumiAnchor,
  lumiOnStep,
  presence,
  sampleTrack,
  trustStep,
  within,
} from "./timeline";

describe("chapterFromScroll", () => {
  const centers = [500, 1500, 2500, 4500];

  it("is the chapter index when that chapter is centred", () => {
    centers.forEach((center, index) => expect(chapterFromScroll(centers, center)).toBe(index));
  });

  it("interpolates between neighbouring centres, however far apart they are", () => {
    expect(chapterFromScroll(centers, 1000)).toBeCloseTo(0.5);
    // Chapter 2 → 3 is twice as tall; halfway is still 2.5.
    expect(chapterFromScroll(centers, 3500)).toBeCloseTo(2.5);
  });

  it("clamps before the first and after the last chapter", () => {
    expect(chapterFromScroll(centers, -200)).toBe(0);
    expect(chapterFromScroll(centers, 99999)).toBe(3);
  });

  it("copes with no chapters and with coincident centres", () => {
    expect(chapterFromScroll([], 100)).toBe(0);
    expect(Number.isFinite(chapterFromScroll([100, 100, 300], 100))).toBe(true);
  });
});

describe("handoff", () => {
  it("holds still at both ends so a centred chapter reads against a still scene", () => {
    expect(handoff(0)).toBe(0);
    expect(handoff(0.2)).toBe(0);
    expect(handoff(0.8)).toBe(1);
    expect(handoff(1)).toBe(1);
  });

  it("is monotonic and symmetric in between", () => {
    let previous = 0;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const value = handoff(f);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(handoff(0.5)).toBeCloseTo(0.5);
  });
});

describe("sampleTrack", () => {
  const keys = [10, 20, 0, 40];

  it("returns the key at each chapter", () => {
    keys.forEach((key, index) => expect(sampleTrack(keys, index)).toBe(key));
  });

  it("stays between neighbouring keys and clamps outside the track", () => {
    const mid = sampleTrack(keys, 0.5);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    expect(sampleTrack(keys, -3)).toBe(10);
    expect(sampleTrack(keys, 30)).toBe(40);
  });

  it("handles degenerate tracks", () => {
    expect(sampleTrack([], 1)).toBe(0);
    expect(sampleTrack([7], 5)).toBe(7);
  });
});

describe("presence and within", () => {
  it("is full on its own chapter and gone by the next", () => {
    expect(presence(2, 2)).toBe(1);
    expect(presence(3, 2)).toBe(0);
    expect(presence(1, 2)).toBe(0);
  });

  it("never has two neighbouring props fully present at once", () => {
    for (let c = 0; c <= LAST_CHAPTER; c += 0.05) {
      expect(presence(c, 1) + presence(c, 2)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("runs 0→1 across a chapter's time on stage", () => {
    expect(within(1.5, 2)).toBe(0);
    expect(within(2, 2)).toBeCloseTo(0.5);
    expect(within(2.5, 2)).toBe(1);
    expect(within(9, 2)).toBe(1);
  });
});

describe("staging", () => {
  it("keeps Lumi on screen in every chapter and layout", () => {
    for (const layout of ["desktop", "mobile"] as const) {
      for (let c = 0; c <= LAST_CHAPTER; c += 0.1) {
        const anchor = lumiAnchor(layout, c);
        expect(Math.abs(anchor.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(anchor.y)).toBeLessThanOrEqual(1);
        expect(anchor.s).toBeGreaterThan(0);
      }
    }
  });

  it("has one anchor per chapter", () => {
    expect(lumiAnchor("desktop", LAST_CHAPTER)).toEqual(lumiAnchor("desktop", CHAPTERS.length + 5));
  });

  it("builds a staircase that climbs with every level, with Lumi above each step", () => {
    for (const layout of ["desktop", "mobile"] as const) {
      for (let level = 0; level < TRUST_LEVELS; level++) {
        const step = trustStep(layout, level);
        expect(lumiOnStep(layout, level).y).toBeGreaterThan(step.y);
        expect(lumiOnStep(layout, level).y).toBeLessThanOrEqual(1);
        if (level > 0) {
          expect(step.x).toBeGreaterThan(trustStep(layout, level - 1).x);
          expect(step.y).toBeGreaterThan(trustStep(layout, level - 1).y);
        }
      }
    }
  });

  it("is on the ground for the opening and the ending, and aloft in between", () => {
    expect(altitude(0)).toBe(0);
    expect(altitude(LAST_CHAPTER)).toBe(0);
    for (let c = 1; c <= LAST_CHAPTER - 1; c++) expect(altitude(c)).toBe(1);
  });
});
