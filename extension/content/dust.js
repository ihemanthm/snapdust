// WebGL2 renderer for the two effects, drawn on top of the room picture:
//   dust:   the body flakes away into grey-brown ash that drifts off (Infinity War snap)
//   return: the same dust played backwards, glowing gold: flakes fly back along the paths
//           they left on and the body rebuilds, last part gone first back (Endgame return)
//
// Both use one "dissolve field": a value per pixel from 0 to 1, made of a sweep across the
// body plus noise. As progress passes a pixel's value, that pixel turns to ash. Particles are
// one per body cell; each one comes loose at its cell's field value, so the ash always leaves
// from the dissolving edge. The return simply runs progress backwards.
//
// Loaded into the page before inject.js, which picks it up from window.__SnapDustRenderer.
(() => {
  if (window.__SnapDustRenderer) return;

  const GRID_W = 192; // particle cells across; rows follow the aspect ratio
  const PER_CELL = 2;
  // Longest particle life, in seconds. inject.js uses this to know when the effect is over.
  const MAX_LIFE = 2.4;

  const COMMON = `
    uniform vec2 uDir;      // sweep direction, in aspect-corrected space
    uniform vec2 uRange;    // min/max of the sweep over the body
    uniform float uAspect;
    uniform float uSeed;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                 mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    // 0..1: when this spot dissolves (dust) or reforms (return).
    float field(vec2 uv) {
      vec2 q = vec2(uv.x * uAspect, uv.y);
      float sweep = clamp((dot(q, uDir) - uRange.x) / max(uRange.y - uRange.x, 1e-3), 0.0, 1.0);
      return sweep * 0.7 + fbm(q * 7.0 + uSeed) * 0.3;
    }
  `;

  const QUAD_VS = `#version 300 es
    out vec2 vUv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      vUv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

  const BODY_FS = `#version 300 es
    precision highp float;
    ${COMMON}
    uniform sampler2D uBody;
    uniform sampler2D uMask;
    uniform float uP;
    uniform int uMode; // 0 = dust, 1 = return
    in vec2 vUv;
    out vec4 o;
    void main() {
      float m = smoothstep(0.35, 0.65, texture(uMask, vUv).a);
      if (m < 0.01) { o = vec4(0.0); return; }
      vec3 c = texture(uBody, vUv).rgb;
      float f = field(vUv);
      float left = f - uP;                // > 0: still (or already back) in place
      if (left <= 0.0) { o = vec4(0.0); return; }
      float edge = smoothstep(0.09, 0.0, left);
      if (uMode == 0) {
        // Near the edge the skin greys into ash before it breaks off.
        vec3 ash = vec3(dot(c, vec3(0.3, 0.59, 0.11))) * vec3(0.78, 0.7, 0.62);
        c = mix(c, ash, edge * 0.9);
      } else {
        // Coming back, the edge glows gold as the pieces settle.
        vec3 gold = vec3(1.0, 0.74, 0.34);
        c = mix(c, gold, edge * 0.6) + gold * edge * 0.45;
      }
      // Ragged, flaky edge.
      float flake = step(0.45, hash(floor(vUv * vec2(uAspect, 1.0) * 260.0) + uSeed));
      float a = m * (left > 0.025 ? 1.0 : flake);
      o = vec4(c * a, a);
    }`;

  const PARTICLE_VS = `#version 300 es
    precision highp float;
    ${COMMON}
    uniform sampler2D uBody;
    uniform sampler2D uMask;
    uniform vec2 uGrid;
    uniform float uP;
    uniform float uDuration;   // seconds for progress 0 -> 1
    uniform float uPointScale;
    uniform int uMode;
    out vec4 vColor;
    flat out int vMode;
    void main() {
      vMode = uMode;
      int id = gl_VertexID;
      int cell = id / ${PER_CELL};
      int gw = int(uGrid.x);
      float r1 = hash(vec2(float(id), 1.7));
      float r2 = hash(vec2(float(id), 9.1));
      float r3 = hash(vec2(float(id), 4.3));
      vec2 uv0 = (vec2(float(cell % gw), float(cell / gw)) + vec2(r1, r2)) / uGrid;

      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);  // off screen unless shown below
      gl_PointSize = 0.0;
      vColor = vec4(0.0);
      if (texture(uMask, uv0).a < 0.5) return;

      float f = field(uv0);
      float life = mix(1.2, ${MAX_LIFE.toFixed(1)}, r3);
      vec3 c = texture(uBody, uv0).rgb;
      vec2 pos;
      vec3 col;
      float alpha;
      float size;
      // Seconds since this bit came loose. During the return progress runs backwards, so each
      // bit retraces its path and lands back where it left.
      float t = (uP - f) * uDuration;
      if (t < 0.0 || t > life) return;
      float k = t / life;
      // Carried off by a breeze along the sweep, rising a little, with some flutter.
      vec2 wind = vec2(uDir.x / uAspect, uDir.y) * 0.07 + vec2(0.0, 0.035);
      vec2 drift = wind * (t + 0.7 * t * t) * (0.6 + 0.8 * r1);
      drift += 0.02 * t * vec2(sin(r1 * 40.0 + t * 3.1), cos(r2 * 40.0 + t * 2.7));
      pos = uv0 + drift;
      if (uMode == 0) {
        col = mix(c, vec3(0.33, 0.3, 0.27), smoothstep(0.0, 0.3, k));
        alpha = 1.0 - smoothstep(0.35, 1.0, k);
        size = mix(2.6, 1.0, k);
      } else {
        // Gold while in flight, taking on the body's colour as it lands.
        col = mix(c, vec3(1.0, 0.76, 0.36) * 1.25, smoothstep(0.0, 0.25, k));
        alpha = 1.0 - smoothstep(0.45, 1.0, k);
        size = mix(2.8, 1.6, k);
      }
      gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = uPointScale * size * (0.6 + r2);
      vColor = vec4(col * alpha, alpha);
    }`;

  const PARTICLE_FS = `#version 300 es
    precision highp float;
    in vec4 vColor;
    flat in int vMode;
    out vec4 o;
    void main() {
      vec2 p = abs(gl_PointCoord - 0.5);
      // Ash: square flakes. Gold: soft round sparks.
      float shape = vMode == 0
        ? 1.0 - smoothstep(0.3, 0.5, max(p.x, p.y))
        : 1.0 - smoothstep(0.1, 0.5, length(p));
      o = vColor * shape;
    }`;

  function compile(gl, vsSource, fsSource) {
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vsSource],
      [gl.FRAGMENT_SHADER, fsSource],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`SnapDust shader: ${gl.getShaderInfoLog(shader)}`);
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`SnapDust program: ${gl.getProgramInfoLog(program)}`);
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name } = gl.getActiveUniform(program, i);
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  class SnapDustRenderer {
    constructor(width, height) {
      this.canvas = new OffscreenCanvas(width, height);
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;
      this.body = compile(gl, QUAD_VS, BODY_FS);
      this.particles = compile(gl, PARTICLE_VS, PARTICLE_FS);
      this.vao = gl.createVertexArray(); // attribute-free drawing still needs one bound
      this.bodyTex = this.makeTexture();
      this.maskTex = this.makeTexture();
      this.field = { dir: [1, 0], range: [0, 1], seed: 0 };
      this.resize(width, height);
    }

    static get maxLife() {
      return MAX_LIFE;
    }

    makeTexture() {
      const { gl } = this;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    resize(width, height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.aspect = width / height;
      this.grid = [GRID_W, Math.round(GRID_W / this.aspect)];
    }

    upload(tex, source) {
      const { gl } = this;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // so uv (0,0) is the bottom-left, like GL
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    setBody(source) {
      this.upload(this.bodyTex, source);
    }

    setMask(source) {
      this.upload(this.maskTex, source);
    }

    // Picks a sweep direction and measures the body along it. `bbox` is in image uv
    // (0..1, y down) and covers the person.
    setField(bbox) {
      const angle = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.9;
      const dir = [Math.cos(angle), Math.sin(angle)];
      const corners = [
        [bbox.x0, 1 - bbox.y0],
        [bbox.x1, 1 - bbox.y0],
        [bbox.x0, 1 - bbox.y1],
        [bbox.x1, 1 - bbox.y1],
      ].map(([u, v]) => u * this.aspect * dir[0] + v * dir[1]);
      this.field = { dir, range: [Math.min(...corners), Math.max(...corners)], seed: Math.random() * 100 };
      this.fieldSet = true;
    }

    // mode: 'dust' | 'return'; progress: 0 -> 1 over `duration` seconds as the body dissolves,
    // up to 1 + maxLife / duration once the last ash is gone. The return passes the same
    // progress running backwards. Returns the canvas to draw over the frame.
    render(mode, progress, duration) {
      const { gl, canvas } = this;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);

      const modeId = mode === 'dust' ? 0 : 1;
      const setCommon = (u) => {
        gl.uniform2f(u.uDir, ...this.field.dir);
        gl.uniform2f(u.uRange, ...this.field.range);
        gl.uniform1f(u.uAspect, this.aspect);
        gl.uniform1f(u.uSeed, this.field.seed);
        gl.uniform1i(u.uBody, 0);
        gl.uniform1i(u.uMask, 1);
        gl.uniform1f(u.uP, progress);
        gl.uniform1i(u.uMode, modeId);
      };

      gl.useProgram(this.body.program);
      setCommon(this.body.uniforms);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const p = this.particles;
      gl.useProgram(p.program);
      setCommon(p.uniforms);
      gl.uniform2f(p.uniforms.uGrid, ...this.grid);
      gl.uniform1f(p.uniforms.uDuration, duration);
      gl.uniform1f(p.uniforms.uPointScale, Math.max(1, canvas.height / 360));
      gl.drawArrays(gl.POINTS, 0, this.grid[0] * this.grid[1] * PER_CELL);
      return canvas;
    }
  }

  window.__SnapDustRenderer = SnapDustRenderer;
})();
