import { FRAME_MS, fieldScale, isDarkColour, motionPlan, parseColour } from "../landingMotion.js";

/**
 * The front page's background field: one fragment shader on a full-screen triangle. A slow,
 * soft flow of the accent over the page's own ground, leaning a little toward the pointer.
 * It is loaded on its own (a dynamic import), so the app's first download does not carry it.
 * It reads its three colours from the page's tokens, so it follows the theme. It never throws:
 * with no context, a failed compile or a lost context it returns null or stops, and the page's
 * plain gradient stays. Nothing here evaluates text as code; the shader source is handed to
 * the graphics driver, which the page's content policy allows.
 */

const VERTEX = `attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPtr;
uniform vec3 uBg;
uniform vec3 uLive;
uniform float uDark;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 m = (uPtr - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float t = uTime * 0.05;
  vec2 q = vec2(fbm(p * 1.5 + t), fbm(p * 1.5 + vec2(5.2, 1.3) - t));
  float f = fbm(p * 1.3 + 2.0 * q + vec2(0.0, t));
  float d = length(p - m);
  f += 0.22 * exp(-d * d * 5.0);
  float glow = smoothstep(0.38, 0.95, f);
  glow *= 0.35 + 0.65 * smoothstep(0.0, 0.7, 1.0 - uv.y);
  float amount = glow * mix(0.11, 0.24, uDark);
  vec3 col = mix(uBg, uLive, amount);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const FALLBACK_BG: readonly [number, number, number] = [1, 1, 1];
const FALLBACK_LIVE: readonly [number, number, number] = [0.91, 0.36, 0.14];

/**
 * Starts the field in `canvas`, with `area` as the box the pointer is read over. Returns a
 * function that stops it and lets everything go, or null when it cannot run at all.
 */
export function startField(canvas: HTMLCanvasElement, area: HTMLElement): (() => void) | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  } catch {
    gl = null;
  }
  if (gl === null) return null;
  const context: WebGLRenderingContext = gl;

  const vs = compile(context, context.VERTEX_SHADER, VERTEX);
  const fs = compile(context, context.FRAGMENT_SHADER, FRAGMENT);
  const program = context.createProgram();
  const buffer = context.createBuffer();
  if (vs === null || fs === null || program === null || buffer === null) return null;
  context.attachShader(program, vs);
  context.attachShader(program, fs);
  context.linkProgram(program);
  if (context.getProgramParameter(program, context.LINK_STATUS) !== true) return null;
  context.useProgram(program);
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
  const aPos = context.getAttribLocation(program, "aPos");
  context.enableVertexAttribArray(aPos);
  context.vertexAttribPointer(aPos, 2, context.FLOAT, false, 0, 0);
  const at = (name: string): WebGLUniformLocation | null => context.getUniformLocation(program, name);
  const uRes = at("uRes");
  const uTime = at("uTime");
  const uPtr = at("uPtr");
  const uBg = at("uBg");
  const uLive = at("uLive");
  const uDark = at("uDark");

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reduce.matches;
  let visible = document.visibilityState !== "hidden";
  let onScreen = true;
  let lost = false;
  let frame = 0;
  let last = 0;
  let count = 0;
  let began = performance.now();
  let target: [number, number] = [0.5, 0.5];
  let ptr: [number, number] = [0.5, 0.5];
  let bg = FALLBACK_BG;
  let live = FALLBACK_LIVE;
  let dark = 0;

  const readColours = (): void => {
    const style = getComputedStyle(canvas);
    bg = parseColour(style.getPropertyValue("--vemi-page")) ?? FALLBACK_BG;
    live = parseColour(style.getPropertyValue("--vemi-live")) ?? FALLBACK_LIVE;
    dark = isDarkColour(bg) ? 1 : 0;
  };

  const size = (): void => {
    const scale = fieldScale(window.devicePixelRatio);
    const w = Math.max(2, Math.round(canvas.clientWidth * scale));
    const h = Math.max(2, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    context.viewport(0, 0, w, h);
  };

  const draw = (now: number): void => {
    ptr = [ptr[0] + (target[0] - ptr[0]) * 0.06, ptr[1] + (target[1] - ptr[1]) * 0.06];
    if (count++ % 45 === 0) readColours();
    size();
    context.uniform2f(uRes, canvas.width, canvas.height);
    context.uniform1f(uTime, (now - began) / 1000);
    context.uniform2f(uPtr, ptr[0], ptr[1]);
    context.uniform3f(uBg, bg[0], bg[1], bg[2]);
    context.uniform3f(uLive, live[0], live[1], live[2]);
    context.uniform1f(uDark, dark);
    context.drawArrays(context.TRIANGLES, 0, 3);
  };

  const plan = (): ReturnType<typeof motionPlan> =>
    lost ? "still" : motionPlan({ reducedMotion: reduced, hasWebGL: true, pageVisible: visible, onScreen });

  const tick = (now: number): void => {
    frame = 0;
    if (plan() !== "run") return;
    if (now - last >= FRAME_MS) {
      last = now;
      try {
        draw(now);
      } catch {
        stopLoop();
        canvas.classList.remove("on");
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  };

  function stopLoop(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  }

  const apply = (): void => {
    const now = plan();
    canvas.classList.toggle("on", now !== "still");
    if (now === "run") {
      if (frame === 0) frame = requestAnimationFrame(tick);
    } else {
      stopLoop();
    }
  };

  const move = (e: PointerEvent): void => {
    const box = area.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    target = [Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), Math.max(0, Math.min(1, 1 - (e.clientY - box.top) / box.height))];
  };
  const onVisible = (): void => { visible = document.visibilityState !== "hidden"; apply(); };
  const onMotion = (): void => { reduced = reduce.matches; apply(); };
  const onLost = (e: Event): void => { e.preventDefault(); lost = true; apply(); };

  let watch: IntersectionObserver | null = null;
  try {
    watch = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) { onScreen = entry.isIntersecting; apply(); }
    });
    watch.observe(area);
  } catch {
    watch = null;
  }

  readColours();
  try {
    draw(performance.now());
  } catch {
    return null;
  }
  area.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("visibilitychange", onVisible);
  reduce.addEventListener("change", onMotion);
  canvas.addEventListener("webglcontextlost", onLost);
  began = performance.now();
  apply();

  return () => {
    stopLoop();
    watch?.disconnect();
    area.removeEventListener("pointermove", move);
    document.removeEventListener("visibilitychange", onVisible);
    reduce.removeEventListener("change", onMotion);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.classList.remove("on");
    try {
      context.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Already gone.
    }
  };
}

/** The source of the shader, so a test can prove what it does not contain. */
export const SHADER_SOURCE = { vertex: VERTEX, fragment: FRAGMENT } as const;
