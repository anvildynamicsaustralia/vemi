import { describe, expect, it } from "vitest";
import { FRAME_MS, MAX_TILT, fieldScale, isDarkColour, motionPlan, parseColour, tiltFor } from "./landingMotion.js";
import { SHADER_SOURCE } from "./ui/landingShader.js";

const on = { reducedMotion: false, hasWebGL: true, pageVisible: true, onScreen: true };

describe("motionPlan", () => {
  it("runs when motion is allowed, WebGL is there and the field is showing", () => {
    expect(motionPlan(on)).toBe("run");
  });
  it("stays still, never looping, for reduced motion or no WebGL", () => {
    expect(motionPlan({ ...on, reducedMotion: true })).toBe("still");
    expect(motionPlan({ ...on, hasWebGL: false })).toBe("still");
    expect(motionPlan({ ...on, reducedMotion: true, pageVisible: false })).toBe("still");
  });
  it("pauses in a hidden tab and when scrolled away", () => {
    expect(motionPlan({ ...on, pageVisible: false })).toBe("pause");
    expect(motionPlan({ ...on, onScreen: false })).toBe("pause");
  });
});

describe("tiltFor", () => {
  const box = { left: 100, top: 100, width: 400, height: 200 };
  it("is flat at the centre", () => expect(tiltFor(300, 200, box)).toEqual({ rx: 0, ry: 0 }));
  it("leans at most the maximum, at the edges and beyond", () => {
    expect(tiltFor(500, 300, box)).toEqual({ rx: -MAX_TILT, ry: MAX_TILT });
    expect(tiltFor(9000, -9000, box)).toEqual({ rx: MAX_TILT, ry: MAX_TILT });
    expect(tiltFor(0, 400, box, 2)).toEqual({ rx: -2, ry: -2 });
  });
  it("is flat for an empty box", () => expect(tiltFor(5, 5, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ rx: 0, ry: 0 }));
});

describe("colours for the shader", () => {
  it("reads #rgb and #rrggbb, and nothing else", () => {
    expect(parseColour("#ffffff")).toEqual([1, 1, 1]);
    expect(parseColour(" #000 ")).toEqual([0, 0, 0]);
    expect(parseColour("#e85c24")?.map((n) => Math.round(n * 255))).toEqual([232, 92, 36]);
    for (const bad of ["", "red", "rgb(1,2,3)", "#12", "#1234567"]) expect(parseColour(bad)).toBeNull();
  });
  it("tells a dark ground from a light one", () => {
    expect(isDarkColour([0.07, 0.07, 0.06])).toBe(true);
    expect(isDarkColour([1, 1, 1])).toBe(false);
  });
});

describe("the field's cost", () => {
  it("is drawn about 30 times a second at a share of the pixels, never above 1.5x of half", () => {
    expect(FRAME_MS).toBeCloseTo(33.3, 0);
    expect(fieldScale(1)).toBe(0.5);
    expect(fieldScale(3)).toBe(0.75);
    expect(fieldScale(0)).toBe(0.5);
    expect(fieldScale(Number.NaN)).toBe(0.5);
  });
});

describe("the shader source", () => {
  it("is plain GLSL: a vertex and a fragment part that name no eval and no outside file", () => {
    for (const source of Object.values(SHADER_SOURCE)) {
      expect(source).toContain("void main()");
      expect(source).not.toMatch(/eval|import|http|texture2D/);
    }
    expect(SHADER_SOURCE.fragment).toContain("gl_FragColor");
  });
});
