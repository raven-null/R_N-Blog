/* 桌宠引擎：弹簧驱动的多边形小生物（自制）
   —— 机制参考 spring character 的通用做法（挤压拉伸 / 多边形眼睛 / 状态机 / 指针跟随），
      造型与几何数据全部原创，不涉及第三方角色素材。

   用法：
     const pet = PetEngine.mount(svgElement, { size: 96 });
     pet.setState('curious');
     pet.setGaze(clientX, clientY);
     pet.poke();  pet.sleep();  pet.wake();
*/
(function (global) {
  'use strict';

  // 每个状态给一组目标值，所有参数都是弹簧，逐帧追过去
  const STATES = {
    idle:      { sx: 1.00, sy: 1.00, rot: 0,  open: 1.00, smile: 0.16, glow: 0.55, hop: 0 },
    curious:   { sx: 1.05, sy: 0.96, rot: 3,  open: 1.14, smile: 0.34, glow: 0.78, hop: 0 },
    listening: { sx: 1.02, sy: 1.05, rot: -3, open: 1.10, smile: 0.10, glow: 0.85, hop: 0 },
    thinking:  { sx: 0.97, sy: 1.06, rot: 4,  open: 0.78, smile: 0.02, glow: 0.62, hop: 0 },
    poke:      { sx: 1.17, sy: 0.85, rot: -2, open: 0.52, smile: 0.62, glow: 0.95, hop: 1 },
    happy:     { sx: 1.09, sy: 0.92, rot: 0,  open: 0.18, smile: 0.86, glow: 1.00, hop: 0 },
    dragged:   { sx: 0.93, sy: 1.11, rot: 0,  open: 1.42, smile: 0.24, glow: 0.9,  hop: 0 },
    sleeping:  { sx: 1.06, sy: 0.94, rot: 0,  open: 0.04, smile: 0.00, glow: 0.16, hop: 0 },
  };

  // 状态机：进入某状态后多久回 idle（0 = 停在该状态）
  const HOLD = {
    idle: 0, curious: 0, listening: 0, thinking: 0, sleeping: 0, dragged: 0,
    poke: 900, happy: 1400,
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function Pet(svg) {
    this.svg = svg;
    this.root = svg.querySelector('#petRoot');
    this.body = svg.querySelector('.pet-body');
    this.eyes = svg.querySelector('#petEyes');
    this.eyesHappy = svg.querySelector('#petEyesHappy');
    this.eyeL = svg.querySelector('#petEyeL');
    this.eyeR = svg.querySelector('#petEyeR');
    this.mouth = svg.querySelector('#petMouth');
    this.gloss = svg.querySelector('#petGloss');
    this.antennaDot = svg.querySelector('#petAntennaDot');
    this.gazeTarget = { x: 0, y: 0 };
    this.gaze = { x: 0, y: 0 };
    this.state = 'idle';
    this.stateUntil = 0;

    // 弹簧参数（位置/速度）
    this.p = {
      sx: { x: 1, v: 0 }, sy: { x: 1, v: 0 }, rot: { x: 0, v: 0 },
      open: { x: 1, v: 0 }, smile: { x: 0.1, v: 0 }, glow: { x: 0.6, v: 0 },
      hop: { x: 0, v: 0 }, lookX: { x: 0, v: 0 }, lookY: { x: 0, v: 0 },
    };
    this.blink = { next: performance.now() + 1800, until: 0, value: 1 };
    this.raf = 0;
    this.last = performance.now();
    this.breath = 0;
    this.running = false;
    this.start();
  }

  Pet.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      const dt = clamp((now - this.last) / 1000, 0, 0.05);
      this.last = now;
      this.step(dt, now);
      this.paint(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Pet.prototype.destroy = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  };

  Pet.prototype.setState = function (name) {
    if (!STATES[name] || name === this.state) return;
    this.state = name;
    const hold = HOLD[name] || 0;
    this.stateUntil = hold ? performance.now() + hold : 0;
  };

  Pet.prototype.poke = function () {
    this.setState('poke');
    this.blink.value = 1;
  };

  Pet.prototype.sleep = function () { this.setState('sleeping'); };
  Pet.prototype.wake = function () { this.setState('idle'); };

  Pet.prototype.setGaze = function (clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.6;
    this.gazeTarget.x = clamp((clientX - cx) / 220, -1, 1);
    this.gazeTarget.y = clamp((clientY - cy) / 220, -1, 1);
  };

  // 一次二阶弹簧积分：目标值、刚度、阻尼
  function spring(node, target, k, d, dt) {
    const force = (target - node.x) * k - node.v * d;
    node.v += force * dt;
    node.x += node.v * dt;
    return node.x;
  }

  Pet.prototype.step = function (dt, now) {
    // 到点回 idle
    if (this.stateUntil && now >= this.stateUntil) {
      this.state = 'idle';
      this.stateUntil = 0;
    }

    const t = STATES[this.state] || STATES.idle;
    this.breath += dt;
    const breath = Math.sin(this.breath * 2.2) * 0.012;

    spring(this.p.sx, t.sx + breath, 260, 22, dt);
    spring(this.p.sy, t.sy - breath, 260, 22, dt);
    spring(this.p.rot, t.rot, 210, 19, dt);
    spring(this.p.open, t.open, 320, 24, dt);
    spring(this.p.smile, t.smile, 240, 20, dt);
    spring(this.p.glow, t.glow, 150, 16, dt);
    spring(this.p.hop, t.hop, 300, 26, dt);
    spring(this.p.lookX, this.gazeTarget.x * 3.4, 90, 14, dt);
    spring(this.p.lookY, this.gazeTarget.y * 2.6, 90, 14, dt);

    // 眨眼：随机间隔，一闭一开约 0.3 秒
    if (now >= this.blink.next && this.state !== 'sleeping') {
      this.blink.until = now + 150;
      this.blink.next = now + 2200 + Math.random() * 4200;
    }
    const closing = now < this.blink.until;
    this.blink.value = closing ? 0.06 : 1;
  };

  Pet.prototype.paint = function (now) {
    const p = this.p;
    const sx = p.sx.x;
    const sy = p.sy.x;
    const rot = p.rot.x + Math.sin(now / 1400) * 0.6;
    const openRaw = clamp(p.open.x, 0, 1.6);
    const openness = openRaw * this.blink.value;
    const smile = clamp(p.smile.x, 0, 1);
    const glow = clamp(p.glow.x, 0, 1);

    if (this.root) {
      this.root.setAttribute(
        'transform',
        `translate(60 116) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-60 -116)`
      );
    }

    // 眼睛：椭圆高度跟着 open 走；太小就换成笑眼弧线
    const ry = 9 * openness;
    const eyeOpacity = openness < 0.22 ? 0 : 1;
    if (this.eyeL && this.eyeR) {
      this.eyeL.setAttribute('ry', ry.toFixed(2));
      this.eyeR.setAttribute('ry', ry.toFixed(2));
      this.eyeL.style.opacity = eyeOpacity;
      this.eyeR.style.opacity = eyeOpacity;
      const lx = p.lookX.x;
      const ly = p.lookY.x;
      this.eyes.setAttribute('transform', `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`);
    }
    if (this.eyesHappy) {
      this.eyesHappy.style.opacity = openness < 0.22 ? 1 : 0;
      this.eyesHappy.setAttribute('transform', `translate(${p.lookX.x.toFixed(2)} ${p.lookY.x.toFixed(2)})`);
    }

    // 嘴：从平嘴到大笑
    if (this.mouth) {
      const mx = 54;
      const my = 86 + Math.abs(p.lookY.x) * 0.4;
      const w = 12;
      const dip = 2 + smile * 9;
      this.mouth.setAttribute(
        'd',
        `M${mx} ${my.toFixed(2)} q${(w / 2).toFixed(2)} ${dip.toFixed(2)} ${w} 0`
      );
    }

    if (this.gloss) {
      this.gloss.style.opacity = (0.25 + glow * 0.45).toFixed(2);
    }
    if (this.antennaDot) {
      this.antennaDot.style.opacity = (0.45 + glow * 0.55).toFixed(2);
      this.antennaDot.setAttribute('r', (3.2 + glow * 1.6).toFixed(2));
    }

    // 整体轻微上下浮动（状态里有 hop 时弹一下）
    const hop = Math.max(0, p.hop.x);
    const lift = Math.sin(now / 900) * 2.4 + hop * 6;
    this.svg.style.transform = `translateY(${(-lift).toFixed(2)}px)`;
  };

  global.PetEngine = {
    states: Object.keys(STATES),
    mount(svg) {
      if (!svg) return null;
      if (svg.__pet) return svg.__pet;
      const pet = new Pet(svg);
      svg.__pet = pet;
      return pet;
    },
  };
})(window);
