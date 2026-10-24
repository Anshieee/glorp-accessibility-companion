'use client';

import React, { useEffect, useRef } from 'react';

interface ShaderBackgroundProps {
  className?: string;
  speed?: number;
}

export const ShaderBackground: React.FC<ShaderBackgroundProps> = ({
  className = '',
  speed = 1.0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Respect reduced motion: render one still frame, no animation loop.
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const paintFallback = () => {
      // Still-frame gradient fallback (no WebGL, no GPU work, never throws).
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = (canvas.width = canvas.clientWidth || 800);
        const h = (canvas.height = canvas.clientHeight || 600);
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#060310');
        g.addColorStop(0.45, '#1a0b38');
        g.addColorStop(0.72, '#3d1478');
        g.addColorStop(1, '#0a0518');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      } catch {
        /* ignore: decorative background must never break the page */
      }
    };

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: true,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false,
      });
    } catch {
      gl = null;
    }

    if (!gl) {
      paintFallback();
      return;
    }

    const vsSource = `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // High quality silk/computation fluid shader reproducing the reference image visual
    const fsSource = `
      precision highp float;
      uniform vec2 u_resolution;
      uniform float u_time;

      // Hash function
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      // 2D Value Noise
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      // Fractional Brownian Motion
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p = rot * p * 2.05 + vec2(0.12, 0.28);
          a *= 0.48;
        }
        return v;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        float aspect = u_resolution.x / u_resolution.y;
        vec2 st = uv;
        st.x *= aspect;

        float t = u_time * 0.12;

        // Domain warping for smooth computational fluid/silk ripples
        vec2 q = vec2(
          fbm(st * 1.35 + vec2(0.0, t * 0.4)),
          fbm(st * 1.35 + vec2(5.2, 1.3 + t * 0.3))
        );

        vec2 r = vec2(
          fbm(st * 1.5 + 3.2 * q + vec2(1.7 - t * 0.2, 9.2 + t * 0.15)),
          fbm(st * 1.5 + 3.2 * q + vec2(8.3 + t * 0.25, 2.8 - t * 0.1))
        );

        float f = fbm(st * 1.25 + 4.0 * r);

        // Color palette carefully matched to the reference screenshot
        // Deep midnight black/indigo crevice
        vec3 colDarkAbyss   = vec3(0.015, 0.008, 0.035);
        // Deep moody purple
        vec3 colMidShadow   = vec3(0.08, 0.02, 0.18);
        // Rich royal violet
        vec3 colRoyalViolet = vec3(0.24, 0.07, 0.48);
        // Vibrant neon purple fold highlight
        vec3 colBrightFold  = vec3(0.48, 0.16, 0.88);
        // Electric lilac crest
        vec3 colElectricCrest = vec3(0.68, 0.32, 0.98);

        // Blend based on fold depth
        vec3 color = mix(colDarkAbyss, colMidShadow, clamp(f * f * 3.5, 0.0, 1.0));
        color = mix(color, colRoyalViolet, clamp(length(q) * 1.1, 0.0, 1.0));
        color = mix(color, colBrightFold, clamp(pow(r.x, 2.4) * 2.2, 0.0, 1.0));
        color = mix(color, colElectricCrest, clamp(pow(f, 3.8) * 1.4, 0.0, 1.0));

        // Vignette: dark on left & center-bottom like the reference
        float vignette = uv.x * (1.0 - uv.x) * uv.y * (1.0 - uv.y) * 16.0;
        vignette = clamp(pow(vignette, 0.35), 0.0, 1.0);

        // Asymmetric lighting to match the screenshot fold placement
        float asymmetricShadow = smoothstep(-0.2, 0.8, uv.x - uv.y * 0.3 + 0.2);
        color *= (0.45 + 0.65 * asymmetricShadow);

        // Subtle film grain to prevent gradient banding and add tactile texture
        float grain = (hash(gl_FragCoord.xy + fract(u_time * 7.13)) - 0.5) * 0.035;
        color += vec3(grain);

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    // Compile helper
    const createShader = (type: number, source: string) => {
      if (!gl) return null;
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = createShader(gl.VERTEX_SHADER, vsSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vertexShader || !fragmentShader) {
      paintFallback();
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      paintFallback();
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      paintFallback();
      return;
    }

    gl.useProgram(program);

    // Full screen quad buffer
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');

    let animationFrameId = 0;
    let rafActive = false;
    const startTime = performance.now();
    let visible = true;
    let inViewport = true;

    const resize = () => {
      // Cap DPR at 1.5 for efficiency on constrained GPUs.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const displayWidth = Math.floor(canvas.clientWidth * dpr);
      const displayHeight = Math.floor(canvas.clientHeight * dpr);

      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl?.viewport(0, 0, displayWidth, displayHeight);
      }
    };

    const renderStill = (frozenElapsed: number) => {
      if (!gl) return;
      resize();
      gl.useProgram(program);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, frozenElapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const render = (time: number) => {
      rafActive = false;
      if (!visible || !inViewport) return;
      resize();
      const elapsed = ((time - startTime) * 0.001) * speed;

      if (!gl) return;
      gl.useProgram(program);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, elapsed);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationFrameId = requestAnimationFrame(render);
      rafActive = true;
    };

    const kick = () => {
      if (prefersReducedMotion || !visible || !inViewport || rafActive) return;
      animationFrameId = requestAnimationFrame(render);
      rafActive = true;
    };

    window.addEventListener('resize', resize);
    resize();

    if (prefersReducedMotion) {
      // One still frame; no loop, no mouse tracking.
      renderStill(8.0);
    } else {
      kick();

      const onVisibility = () => {
        visible = document.visibilityState !== 'hidden';
        if (visible) kick();
        else if (rafActive) {
          cancelAnimationFrame(animationFrameId);
          rafActive = false;
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      let observer: IntersectionObserver | null = null;
      if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(
          (entries) => {
            inViewport = entries.some((e) => e.isIntersecting);
            if (inViewport) kick();
            else if (rafActive) {
              cancelAnimationFrame(animationFrameId);
              rafActive = false;
            }
          },
          { threshold: 0 },
        );
        observer.observe(container);
      }

      return () => {
        if (rafActive) cancelAnimationFrame(animationFrameId);
        window.removeEventListener('resize', resize);
        document.removeEventListener('visibilitychange', onVisibility);
        observer?.disconnect();
        try {
          gl.deleteBuffer(positionBuffer);
          gl.deleteProgram(program);
          gl.deleteShader(vertexShader);
          gl.deleteShader(fragmentShader);
        } catch {
          /* ignore cleanup errors */
        }
      };
    }

    return () => {
      if (rafActive) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
      try {
        gl.deleteBuffer(positionBuffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
      } catch {
        /* ignore cleanup errors */
      }
    };
  }, [speed]);

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 pointer-events-none overflow-hidden z-0 ${className}`}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full block object-cover"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
};

export default ShaderBackground;
