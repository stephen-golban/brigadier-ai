import { useEffect, useRef, useState } from "react";

// Same analytic color field and shape timing as the selected motion study.
// WebGL keeps continuous animation out of React and scales without video artifacts.
const fragment = `
precision highp float;
uniform vec2 size;
uniform vec2 bounds;
uniform float density;
uniform float time;
uniform float reveal;
uniform float reduced;
uniform float desktop;
float ease(float t) { t=clamp(t,0.,1.);return t*t*(3.-2.*t); }
void main() {
 vec2 p=(vec2(gl_FragCoord.x,size.y-gl_FragCoord.y)-size*.5)/density;
 vec2 uv=p/(bounds*.5);
 float t=mix(time,10.,reduced);
 float u=uv.x+.09*sin(uv.y*3.+t*.25);
 float v=uv.y+.07*sin(uv.x*4.-t*.18);
 float curve=.2+.24*sin(u*2.9+t*.27)+.08*cos(u*6.-t*.22);
 float band=exp(-pow((v-curve)/(.11+.06*cos(u*2.)),2.))*exp(-pow(u/1.05,4.));
 float halo=exp(-pow((v-curve)/.38,2.))*exp(-pow(u/1.1,4.));
 float blend=(tanh(u*2.)+1.)*.5;
 vec3 color=vec3(3.,7.,22.)+(.39*halo+.49*band)*vec3(30.+85.*blend,106.-59.*blend,247.+blend*3.);
 float knot=exp(-pow((u+.52+.11*sin(t*.2))/.21,2.)-pow((v-curve)/.08,2.));
 color+=knot*vec3(26.,76.,78.);
 float expand=mix(1.,ease((time-3.15)/.72),reveal*(1.-reduced));
 float emerge=mix(1.,ease((time-.25)/1.35),reveal*(1.-reduced));
 float theta=atan(p.y,p.x);
 float radius=(18.+68.*emerge)*(1.+.10*sin(theta*3.+t*1.25)+.045*cos(theta*5.-t*.85));
 float orb=length(p*vec2(1.04,.95))-radius;
 float corner=18.*desktop;
 vec2 q=abs(p)-(bounds*.5-vec2(corner));
 float rect=length(max(q,0.))+min(max(q.x,q.y),0.)-corner;
 float dist=mix(orb,rect,expand);
 float feather=22.*(1.-expand)+.45;
 float alpha=(1./(1.+exp(clamp(dist/feather,-40.,40.))))*emerge;
 float spot=exp(-pow((p.x-22.*cos(t))/38.,2.)-pow((p.y+24.*sin(t*.8))/46.,2.));
 color+=spot*vec3(50.,101.,187.)*(1.-expand);
 color+=sin(gl_FragCoord.x*1.73+gl_FragCoord.y*6.89)*cos(gl_FragCoord.x*6.17-gl_FragCoord.y*2.43)*.45;
 float dim=desktop*mix(.48,.12,ease((time-3.5)/2.3))*emerge;
 float outerGlow=exp(-max(dist,0.)/34.)*.14*emerge*(1.-expand);
 float total=alpha+dim*(1.-alpha)+outerGlow*(1.-alpha);
 vec3 rgb=(clamp(color/255.,0.,1.)*alpha+vec3(.05,.10,.22)*outerGlow*(1.-alpha))/max(total,.0001);
 gl_FragColor=vec4(rgb,total);
}`;
// GLSL ES 1.00 lacks tanh; keep the formula portable to WebGL 1/WKWebView.
const source = fragment.replace(
  "tanh(u*2.)",
  "((exp(clamp(u*4.,-20.,20.))-1.)/(exp(clamp(u*4.,-20.,20.))+1.))",
);

export function CosmicField({
  start,
  reveal,
  reduced,
}: {
  start: number;
  reveal: boolean;
  reduced: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);
  const scene = useRef({ start, reveal, reduced });
  const redraw = useRef<(() => void) | null>(null);
  useEffect(() => {
    scene.current = { start, reveal, reduced };
    redraw.current?.();
  }, [start, reveal, reduced]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = el.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
        powerPreference: "low-power",
      });
    } catch {
      /* CSS fallback */
    }
    if (!gl) {
      setFallback(true);
      return;
    }
    const context = gl;
    const shaders: WebGLShader[] = [];
    const program = context.createProgram();
    const buffer = context.createBuffer();
    let raf = 0,
      disposed = false;
    const release = () => {
      if (disposed) return;
      disposed = true;
      redraw.current = null;
      cancelAnimationFrame(raf);
      if (buffer) context.deleteBuffer(buffer);
      if (program) context.deleteProgram(program);
      shaders.forEach((s) => context.deleteShader(s));
    };
    try {
      if (!program || !buffer) throw Error("No renderer");
      for (const [type, code] of [
        [
          context.VERTEX_SHADER,
          "attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}",
        ],
        [context.FRAGMENT_SHADER, source],
      ] as const) {
        const shader = context.createShader(type);
        if (!shader) throw Error("No shader");
        shaders.push(shader);
        context.shaderSource(shader, code);
        context.compileShader(shader);
        if (!context.getShaderParameter(shader, context.COMPILE_STATUS))
          throw Error(context.getShaderInfoLog(shader) ?? "Shader failed");
        context.attachShader(program, shader);
      }
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS))
        throw Error("Link failed");
      context.useProgram(program);
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      context.bufferData(
        context.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        context.STATIC_DRAW,
      );
      const pos = context.getAttribLocation(program, "position");
      context.enableVertexAttribArray(pos);
      context.vertexAttribPointer(pos, 2, context.FLOAT, false, 0, 0);
      const uniforms = Object.fromEntries(
        [
          "size",
          "bounds",
          "density",
          "time",
          "reveal",
          "reduced",
          "desktop",
        ].map((n) => [n, context.getUniformLocation(program, n)]),
      );
      let last = -100;
      const draw = (now: number) => {
        if (disposed) return;
        const { start, reveal, reduced } = scene.current;
        if (now - last >= 1000 / 30) {
          last = now;
          const scale = Math.min(devicePixelRatio || 1, 1.5),
            w = el.clientWidth,
            h = el.clientHeight;
          if (
            el.width !== Math.round(w * scale) ||
            el.height !== Math.round(h * scale)
          ) {
            el.width = Math.round(w * scale);
            el.height = Math.round(h * scale);
            context.viewport(0, 0, el.width, el.height);
          }
          context.uniform2f(uniforms.size, el.width, el.height);
          context.uniform2f(
            uniforms.bounds,
            w,
            h,
          );
          context.uniform1f(uniforms.density, scale);
          context.uniform1f(uniforms.time, (now - start) / 1000);
          context.uniform1f(uniforms.reveal, Number(reveal));
          context.uniform1f(uniforms.reduced, Number(reduced));
          context.uniform1f(uniforms.desktop, 0);
          context.drawArrays(context.TRIANGLES, 0, 6);
        }
        if (!reduced) raf = requestAnimationFrame(draw);
      };
      const resize = () => {
        cancelAnimationFrame(raf);
        last = -100;
        draw(performance.now());
      };
      redraw.current = resize;
      // Changing the scene updates uniforms; it never tears down the GL program.
      resize();
      const lost = (event: Event) => {
        event.preventDefault();
        setFallback(true);
        release();
      };
      document.addEventListener("visibilitychange", resize);
      window.addEventListener("resize", resize);
      el.addEventListener("webglcontextlost", lost);
      return () => {
        document.removeEventListener("visibilitychange", resize);
        window.removeEventListener("resize", resize);
        el.removeEventListener("webglcontextlost", lost);
        release();
      };
    } catch (error) {
      console.warn("Intro renderer unavailable", error);
      release();
      setFallback(true);
    }
  }, []);
  return (
    <div
      className={`cosmic-field ${fallback ? "cosmic-fallback" : ""}`}
      aria-hidden="true"
    >
      <canvas ref={canvas} />
    </div>
  );
}
