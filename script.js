/* ============================================================
   WEBGL FLUID CURSOR  (converted from React to vanilla JS)
   Colours tuned for a dark minimalist portfolio.
   ============================================================ */

(function initFluid() {

  /* ── canvas ── */
  const canvas = document.createElement('canvas');
  canvas.style.cssText = [
    'position:fixed', 'top:0', 'left:0',
    'width:100vw', 'height:100vh',
    'display:block', 'pointer-events:none', 'z-index:50'
  ].join(';');
  document.body.appendChild(canvas);

  /* ── config ── */
  const config = {
    SIM_RESOLUTION:      128,
    DYE_RESOLUTION:      1440,
    DENSITY_DISSIPATION: 3.5,
    VELOCITY_DISSIPATION: 2,
    PRESSURE:            0.1,
    PRESSURE_ITERATIONS: 20,
    CURL:                3,
    SPLAT_RADIUS:        0.2,
    SPLAT_FORCE:         6000,
    SHADING:             true,
    COLOR_UPDATE_SPEED:  10,
    BACK_COLOR:          { r: 0, g: 0, b: 0 },
    TRANSPARENT:         true,
  };

  /* ── pointer ── */
  class PointerPrototype {
    constructor() {
      this.id = -1;
      this.texcoordX = 0; this.texcoordY = 0;
      this.prevTexcoordX = 0; this.prevTexcoordY = 0;
      this.deltaX = 0; this.deltaY = 0;
      this.down = false; this.moved = false;
      this.color = [0, 0, 0];
    }
  }
  const pointers = [new PointerPrototype()];

  /* ── WebGL context ── */
  function getWebGLContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }
    gl.clearColor(0, 0, 0, 1);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat && halfFloat.HALF_FLOAT_OES;
    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(gl, gl.RG16F,   gl.RG,   halfFloatTexType);
      formatR    = getSupportedFormat(gl, gl.R16F,    gl.RED,  halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR    = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }
    return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering } };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      if (internalFormat === gl.R16F)  return getSupportedFormat(gl, gl.RG16F,   gl.RG,   type);
      if (internalFormat === gl.RG16F) return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
      return null;
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  const { gl, ext } = getWebGLContext(canvas);
  if (!ext.supportLinearFiltering) { config.DYE_RESOLUTION = 256; config.SHADING = false; }

  /* ── helpers ── */
  function hashCode(s) {
    if (!s.length) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) { hash = (hash << 5) - hash + s.charCodeAt(i); hash |= 0; }
    return hash;
  }

  function compileShader(type, source, keywords) {
    if (keywords) source = keywords.map(k => '#define ' + k + '\n').join('') + source;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    return p;
  }

  function getUniforms(program) {
    const u = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(program, i).name;
      u[name] = gl.getUniformLocation(program, name);
    }
    return u;
  }

  class Material {
    constructor(vs, fsSrc) {
      this.vertexShader = vs; this.fragmentShaderSource = fsSrc;
      this.programs = []; this.activeProgram = null; this.uniforms = {};
    }
    setKeywords(kw) {
      let hash = 0;
      kw.forEach(k => { hash += hashCode(k); });
      if (!this.programs[hash]) {
        const fs = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, kw);
        this.programs[hash] = createProgram(this.vertexShader, fs);
      }
      if (this.programs[hash] === this.activeProgram) return;
      this.uniforms = getUniforms(this.programs[hash]);
      this.activeProgram = this.programs[hash];
    }
    bind() { gl.useProgram(this.activeProgram); }
  }

  class Program {
    constructor(vs, fs) {
      this.program = createProgram(vs, fs);
      this.uniforms = getUniforms(this.program);
    }
    bind() { gl.useProgram(this.program); }
  }

  /* ── shaders ── */
  const baseVS = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `);

  const copyFS        = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; uniform sampler2D uTexture; void main(){ gl_FragColor = texture2D(uTexture, vUv); }`);
  const clearFS       = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value; void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`);
  const splatFS       = compileShader(gl.FRAGMENT_SHADER, `precision highp float; precision highp sampler2D; varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius; void main(){ vec2 p = vUv - point.xy; p.x *= aspectRatio; vec3 splat = exp(-dot(p,p)/radius)*color; vec3 base = texture2D(uTarget, vUv).xyz; gl_FragColor = vec4(base+splat, 1.0); }`);
  const divergenceFS  = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity; void main(){ float L=texture2D(uVelocity,vL).x, R=texture2D(uVelocity,vR).x, T=texture2D(uVelocity,vT).y, B=texture2D(uVelocity,vB).y; vec2 C=texture2D(uVelocity,vUv).xy; if(vL.x<0.0)L=-C.x; if(vR.x>1.0)R=-C.x; if(vT.y>1.0)T=-C.y; if(vB.y<0.0)B=-C.y; gl_FragColor=vec4(0.5*(R-L+T-B),0,0,1); }`);
  const curlFS        = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity; void main(){ float L=texture2D(uVelocity,vL).y, R=texture2D(uVelocity,vR).y, T=texture2D(uVelocity,vT).x, B=texture2D(uVelocity,vB).x; gl_FragColor=vec4(0.5*(R-L-T+B),0,0,1); }`);
  const vorticityFS   = compileShader(gl.FRAGMENT_SHADER, `precision highp float; precision highp sampler2D; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity, uCurl; uniform float curl, dt; void main(){ float L=texture2D(uCurl,vL).x, R=texture2D(uCurl,vR).x, T=texture2D(uCurl,vT).x, B=texture2D(uCurl,vB).x, C=texture2D(uCurl,vUv).x; vec2 f=0.5*vec2(abs(T)-abs(B),abs(R)-abs(L)); f/=length(f)+0.0001; f*=curl*C; f.y*=-1.0; vec2 v=texture2D(uVelocity,vUv).xy+f*dt; v=min(max(v,-1000.0),1000.0); gl_FragColor=vec4(v,0,1); }`);
  const pressureFS    = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure, uDivergence; void main(){ float L=texture2D(uPressure,vL).x, R=texture2D(uPressure,vR).x, T=texture2D(uPressure,vT).x, B=texture2D(uPressure,vB).x, div=texture2D(uDivergence,vUv).x; gl_FragColor=vec4((L+R+B+T-div)*0.25,0,0,1); }`);
  const gradSubFS     = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure, uVelocity; void main(){ float L=texture2D(uPressure,vL).x, R=texture2D(uPressure,vR).x, T=texture2D(uPressure,vT).x, B=texture2D(uPressure,vB).x; vec2 v=texture2D(uVelocity,vUv).xy; v.xy-=vec2(R-L,T-B); gl_FragColor=vec4(v,0,1); }`);
  const advectionFS   = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uVelocity, uSource;
    uniform vec2 texelSize, dyeTexelSize; uniform float dt, dissipation;
    vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize){
      vec2 st=uv/tsize-0.5, iuv=floor(st), fuv=fract(st);
      vec4 a=texture2D(sam,(iuv+vec2(0.5,0.5))*tsize);
      vec4 b=texture2D(sam,(iuv+vec2(1.5,0.5))*tsize);
      vec4 c=texture2D(sam,(iuv+vec2(0.5,1.5))*tsize);
      vec4 d=texture2D(sam,(iuv+vec2(1.5,1.5))*tsize);
      return mix(mix(a,b,fuv.x),mix(c,d,fuv.x),fuv.y);
    }
    void main(){
      #ifdef MANUAL_FILTERING
        vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize;
        vec4 result=bilerp(uSource,coord,dyeTexelSize);
      #else
        vec2 coord=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize;
        vec4 result=texture2D(uSource,coord);
      #endif
      gl_FragColor=result/(1.0+dissipation*dt);
    }
  `, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']);

  const displayShaderSrc = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uTexture; uniform vec2 texelSize;
    vec3 linearToGamma(vec3 c){ c=max(c,vec3(0)); return max(1.055*pow(c,vec3(0.4166))-0.055,vec3(0)); }
    void main(){
      vec3 c=texture2D(uTexture,vUv).rgb;
      #ifdef SHADING
        vec3 lc=texture2D(uTexture,vL).rgb, rc=texture2D(uTexture,vR).rgb;
        vec3 tc=texture2D(uTexture,vT).rgb, bc=texture2D(uTexture,vB).rgb;
        float dx=length(rc)-length(lc), dy=length(tc)-length(bc);
        vec3 n=normalize(vec3(dx,dy,length(texelSize)));
        float diffuse=clamp(dot(n,vec3(0,0,1))+0.7,0.7,1.0);
        c*=diffuse;
      #endif
      float a=max(c.r,max(c.g,c.b));
      gl_FragColor=vec4(c,a);
    }
  `;

  /* ── programs ── */
  const copyProg      = new Program(baseVS, copyFS);
  const clearProg     = new Program(baseVS, clearFS);
  const splatProg     = new Program(baseVS, splatFS);
  const advProg       = new Program(baseVS, advectionFS);
  const divProg       = new Program(baseVS, divergenceFS);
  const curlProg      = new Program(baseVS, curlFS);
  const vortProg      = new Program(baseVS, vorticityFS);
  const pressProg     = new Program(baseVS, pressureFS);
  const gradSubProg   = new Program(baseVS, gradSubFS);
  const displayMat    = new Material(baseVS, displayShaderSrc);

  /* ── quad blit ── */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target, clear = false) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* ── FBO helpers ── */
  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture: tex, fbo, width: w, height: h,
      texelSizeX: 1/w, texelSizeY: 1/h,
      attach(id) { gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let f1 = createFBO(w, h, internalFormat, format, type, param);
    let f2 = createFBO(w, h, internalFormat, format, type, param);
    return { width:w, height:h, texelSizeX:f1.texelSizeX, texelSizeY:f1.texelSizeY,
      get read(){ return f1; }, set read(v){ f1=v; },
      get write(){ return f2; }, set write(v){ f2=v; },
      swap(){ let t=f1; f1=f2; f2=t; }
    };
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    const n = createFBO(w, h, internalFormat, format, type, param);
    copyProg.bind();
    gl.uniform1i(copyProg.uniforms.uTexture, target.attach(0));
    blit(n);
    return n;
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width===w && target.height===h) return target;
    target.read  = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width=w; target.height=h;
    target.texelSizeX=1/w; target.texelSizeY=1/h;
    return target;
  }

  function getResolution(r) {
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1/ar;
    const mn = Math.round(r), mx = Math.round(r*ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: mx, height: mn } : { width: mn, height: mx };
  }

  function scaleByPixelRatio(v) { return Math.floor(v * (window.devicePixelRatio || 1)); }

  let dye, velocity, divergence, curl, pressure;

  function initFramebuffers() {
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);
    const tt = ext.halfFloatTexType;
    const rgba = ext.formatRGBA, rg = ext.formatRG, r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);
    if (!dye)      dye      = createDoubleFBO(dyeRes.width,  dyeRes.height,  rgba.internalFormat, rgba.format, tt, filtering);
    else           dye      = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, tt, filtering);
    if (!velocity) velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat,   rg.format,   tt, filtering);
    else           velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, tt, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, tt, gl.NEAREST);
    curl       = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, tt, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, tt, gl.NEAREST);
  }

  /* ── colour generation — subtle monochrome for dark portfolio ── */
  function HSVtoRGB(h, s, v) {
    let r,g,b,i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);
    switch(i%6){
      case 0:r=v;g=t;b=p;break; case 1:r=q;g=v;b=p;break;
      case 2:r=p;g=v;b=t;break; case 3:r=p;g=q;b=v;break;
      case 4:r=t;g=p;b=v;break; case 5:r=v;g=p;b=q;break;
    }
    return {r,g,b};
  }

  function generateColor() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    if (isDark) {
      /* cool blue-white tones — subtle on dark background */
      const c = HSVtoRGB(0.55 + Math.random() * 0.15, 0.25 + Math.random() * 0.25, 1.0);
      c.r *= 0.22; c.g *= 0.22; c.b *= 0.22;
      return c;
    } else {
      /* warm dark tones on light background */
      const c = HSVtoRGB(0.05 + Math.random() * 0.1, 0.3, 0.5);
      c.r *= 0.35; c.g *= 0.35; c.b *= 0.35;
      return c;
    }
  }

  function wrap(v, mn, mx) { const r=mx-mn; return r===0 ? mn : ((v-mn)%r)+mn; }

  function correctRadius(r) {
    const ar = canvas.width / canvas.height;
    if (ar > 1) r *= ar;
    return r;
  }
  function correctDeltaX(d) { const ar=canvas.width/canvas.height; if(ar<1)d*=ar; return d; }
  function correctDeltaY(d) { const ar=canvas.width/canvas.height; if(ar>1)d/=ar; return d; }

  /* ── splat ── */
  function splat(x, y, dx, dy, color) {
    splatProg.bind();
    gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProg.uniforms.aspectRatio, canvas.width/canvas.height);
    gl.uniform2f(splatProg.uniforms.point, x, y);
    gl.uniform3f(splatProg.uniforms.color, dx, dy, 0);
    gl.uniform1f(splatProg.uniforms.radius, correctRadius(config.SPLAT_RADIUS/100));
    blit(velocity.write); velocity.swap();
    gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProg.uniforms.color, color.r, color.g, color.b);
    blit(dye.write); dye.swap();
  }

  function splatPointer(p) {
    splat(p.texcoordX, p.texcoordY, p.deltaX*config.SPLAT_FORCE, p.deltaY*config.SPLAT_FORCE, p.color);
  }

  function clickSplat(p) {
    const color = generateColor(); color.r*=10; color.g*=10; color.b*=10;
    splat(p.texcoordX, p.texcoordY, 10*(Math.random()-0.5), 30*(Math.random()-0.5), color);
  }

  /* ── simulation step ── */
  function step(dt) {
    gl.disable(gl.BLEND);
    curlProg.bind();
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vortProg.bind();
    gl.uniform2f(vortProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vortProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vortProg.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vortProg.uniforms.curl, config.CURL);
    gl.uniform1f(vortProg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    divProg.bind();
    gl.uniform2f(divProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProg.bind();
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    pressProg.bind();
    gl.uniform2f(pressProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressProg.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressProg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    gradSubProg.bind();
    gl.uniform2f(gradSubProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradSubProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradSubProg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    advProg.bind();
    gl.uniform2f(advProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
      gl.uniform2f(advProg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    const velId = velocity.read.attach(0);
    gl.uniform1i(advProg.uniforms.uVelocity, velId);
    gl.uniform1i(advProg.uniforms.uSource, velId);
    gl.uniform1f(advProg.uniforms.dt, dt);
    gl.uniform1f(advProg.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    if (!ext.supportLinearFiltering)
      gl.uniform2f(advProg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advProg.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advProg.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render(target) {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    displayMat.bind();
    if (config.SHADING) gl.uniform2f(displayMat.uniforms.texelSize, 1/gl.drawingBufferWidth, 1/gl.drawingBufferHeight);
    gl.uniform1i(displayMat.uniforms.uTexture, dye.read.attach(0));
    blit(target);
  }

  /* ── resize ── */
  function checkResize() {
    const w = scaleByPixelRatio(canvas.clientWidth);
    const h = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width !== w || canvas.height !== h) { canvas.width=w; canvas.height=h; return true; }
    return false;
  }

  /* ── main loop ── */
  displayMat.setKeywords(config.SHADING ? ['SHADING'] : []);
  initFramebuffers();

  let lastTime = Date.now(), colorTimer = 0;

  function frame() {
    const now = Date.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.016666);
    lastTime  = now;

    if (checkResize()) initFramebuffers();

    colorTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorTimer >= 1) {
      colorTimer = wrap(colorTimer, 0, 1);
      pointers.forEach(p => { p.color = generateColor(); });
    }

    pointers.forEach(p => { if (p.moved) { p.moved = false; splatPointer(p); } });

    step(dt);
    render(null);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ── pointer events ── */
  function updateDown(p, id, x, y) {
    p.id=id; p.down=true; p.moved=false;
    p.texcoordX=x/canvas.width; p.texcoordY=1-(y/canvas.height);
    p.prevTexcoordX=p.texcoordX; p.prevTexcoordY=p.texcoordY;
    p.deltaX=0; p.deltaY=0; p.color=generateColor();
  }
  function updateMove(p, x, y) {
    p.prevTexcoordX=p.texcoordX; p.prevTexcoordY=p.texcoordY;
    p.texcoordX=x/canvas.width; p.texcoordY=1-(y/canvas.height);
    p.deltaX=correctDeltaX(p.texcoordX-p.prevTexcoordX);
    p.deltaY=correctDeltaY(p.texcoordY-p.prevTexcoordY);
    p.moved=Math.abs(p.deltaX)>0||Math.abs(p.deltaY)>0;
  }

  let firstMove = false;
  window.addEventListener('mousedown', e => {
    const p=pointers[0];
    updateDown(p, -1, scaleByPixelRatio(e.clientX), scaleByPixelRatio(e.clientY));
    clickSplat(p);
  });
  window.addEventListener('mousemove', e => {
    const p=pointers[0];
    const x=scaleByPixelRatio(e.clientX), y=scaleByPixelRatio(e.clientY);
    if (!firstMove) { updateDown(p, -1, x, y); firstMove=true; }
    updateMove(p, x, y);

    /* also drive DOM cursor & nav */
    mouseX = e.clientX; mouseY = e.clientY;
  });
  window.addEventListener('touchstart', e => {
    const t=e.targetTouches[0];
    updateDown(pointers[0], t.identifier, scaleByPixelRatio(t.clientX), scaleByPixelRatio(t.clientY));
  });
  window.addEventListener('touchmove', e => {
    const t=e.targetTouches[0];
    updateMove(pointers[0], scaleByPixelRatio(t.clientX), scaleByPixelRatio(t.clientY));
  });

})(); // end initFluid IIFE

/* ============================================================
   DOM CURSOR CIRCLE  —  smooth eased ring on top of fluid
   ============================================================ */
const cursorEl = document.getElementById('cursor');
let mouseX = 0, mouseY = 0, curX = 0, curY = 0;
const EASE = 0.28;

(function animateCursor() {
  curX += (mouseX - curX) * EASE;
  curY += (mouseY - curY) * EASE;
  cursorEl.style.transform = `translate(${curX - 9}px, ${curY - 9}px)`;
  requestAnimationFrame(animateCursor);
})();

document.querySelectorAll('a, button, label, .pill, .section-nav-link, .hobby-item')
  .forEach(el => {
    el.addEventListener('mouseenter', () => cursorEl.classList.add('hovering'));
    el.addEventListener('mouseleave', () => cursorEl.classList.remove('hovering'));
  });

/* ============================================================
   THEME TOGGLE
   ============================================================ */
const themeCheck = document.getElementById('themeCheck');
const htmlEl     = document.documentElement;

const saved = localStorage.getItem('theme');
if (saved === 'light') { htmlEl.setAttribute('data-theme','light'); themeCheck.checked=true; }

themeCheck.addEventListener('change', () => {
  const theme = themeCheck.checked ? 'light' : 'dark';
  htmlEl.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
});

/* ============================================================
   ACTIVE NAV
   ============================================================ */
const navLinks = document.querySelectorAll('.nav-link[data-target]');
const navObs   = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const id = e.target.id;
      navLinks.forEach(l => l.classList.toggle('active', l.dataset.target === id));
    }
  });
}, { threshold: 0.25, rootMargin: '0px 0px -20% 0px' });
document.querySelectorAll('section[id]').forEach(s => navObs.observe(s));

/* ============================================================
   FADE-IN ON SCROLL
   ============================================================ */
const fadeObs = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('visible'); fadeObs.unobserve(e.target); }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
document.querySelectorAll('.fade-in').forEach(el => fadeObs.observe(el));

/* ============================================================
   SMOOTH ANCHOR SCROLL
   ============================================================ */
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', e => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ============================================================
   PROJECT VISUAL  —  subtle parallax on hover
   ============================================================ */
document.querySelectorAll('.project-item').forEach(item => {
  const visual = item.querySelector('.project-visual');
  if (!visual) return;

  let rect   = null;
  let rafId  = null;
  let pendingRx = 0, pendingRy = 0;

  item.addEventListener('mouseenter', () => {
    rect = item.getBoundingClientRect(); // cache once on enter, not per-move
    visual.style.transition = 'transform 0.15s ease';
  });

  item.addEventListener('mousemove', e => {
    pendingRx = (e.clientX - rect.left) / rect.width  - 0.5;
    pendingRy = (e.clientY - rect.top)  / rect.height - 0.5;
    if (rafId) return; // already scheduled this frame
    rafId = requestAnimationFrame(() => {
      rafId = null;
      visual.style.transition = 'none'; // direct — no lag during movement
      visual.style.transform = `scale(1.025) translate(${pendingRx * 9}px, ${pendingRy * 9}px)`;
    });
  });

  item.addEventListener('mouseleave', () => {
    rect = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    visual.style.transition = 'transform 0.55s ease';
    visual.style.transform  = 'scale(1) translate(0,0)';
  });
});
