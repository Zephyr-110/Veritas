"use client";

import { useEffect, useRef } from "react";

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function SceneCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    if (!gl) return;

    const vs = compile(
      gl,
      gl.VERTEX_SHADER,
      `attribute vec2 a;
       uniform float uTime;
       uniform vec2 uRes;
       varying float v;
       void main() {
         float x = a.x;
         float z = a.y;
         float y = sin(x * 2.2 + uTime * 0.35) * 0.12 + cos(z * 1.8 + uTime * 0.22) * 0.09;
         vec3 p = vec3(x, y, z);
         float c = cos(0.42), s = sin(0.42);
         vec3 r = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
         r.x += sin(uTime * 0.05) * 0.08;
         vec3 cam = r + vec3(0.0, 0.08, 1.85);
         vec2 ndc = cam.xy / (cam.z * 1.7);
         ndc.x *= uRes.y / uRes.x;
         v = 0.18 + y * 1.4;
         gl_Position = vec4(ndc, 0.0, 1.0);
         gl_PointSize = 1.6;
       }`
    );
    const fs = compile(
      gl,
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       varying float v;
       void main() {
         vec3 col = mix(vec3(0.42, 0.58, 0.92), vec3(0.55, 0.78, 0.76), clamp(v, 0.0, 1.0));
         gl_FragColor = vec4(col, 0.22);
       }`
    );
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const n = 72;
    const pts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        pts.push((i / (n - 1) - 0.5) * 3.4, (j / (n - 1) - 0.5) * 3.4);
      }
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uRes = gl.getUniformLocation(prog, "uRes");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    };
    resize();

    let frame = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.drawArrays(gl.POINTS, 0, pts.length / 2);
      frame = requestAnimationFrame(draw);
    };
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(frame);
      else frame = requestAnimationFrame(draw);
    };
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full opacity-40"
      aria-hidden
    />
  );
}
