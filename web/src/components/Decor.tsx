// Playful refracted-light layer: glowing orbs, glossy "jelly" prisms, rings, capsules, sparkles.
// Purely decorative (aria-hidden, pointer-events none), always behind content.
import { useId, type CSSProperties } from 'react';

type Pos = { left?: string; right?: string; top?: string; bottom?: string };
const C = { violet: '#7C5CFF', pink: '#FF4FA3', amber: '#FFB547', cyan: '#2EE6D6', blue: '#4F8BFF' };


function Prism({ pos, size, rot, c1, c2, opacity = 1, float = 0 }: { pos: Pos; size: number; rot: number; c1: string; c2: string; opacity?: number; float?: number }) {
  const id = `pg${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className={`deco jelly float-${float}`} style={{ ...pos, width: size, height: size * 0.9, opacity, '--rot': `${rot}deg`, '--glow': `${c1}66` } as CSSProperties} viewBox="0 0 100 90">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c1} /><stop offset="1" stopColor={c2} /></linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset=".45" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".35" /></linearGradient>
      </defs>
      <path d="M43 9 Q50 -2 57 9 L94 72 Q100 84 86 84 L14 84 Q0 84 6 72 Z" fill={`url(#${id})`} />
      <path d="M43 9 Q50 -2 57 9 L94 72 Q100 84 86 84 L14 84 Q0 84 6 72 Z" fill={`url(#${id}s)`} />
      <path d="M44 12 Q50 3 56 12 L74 44 Q50 34 27 42 Z" fill={`url(#${id}h)`} />
    </svg>
  );
}

function Sparkle({ pos, size, color, rot = 0, opacity = 1 }: { pos: Pos; size: number; color: string; rot?: number; opacity?: number }) {
  return (
    <svg className="deco twinkle" style={{ ...pos, width: size, height: size, opacity, transform: `rotate(${rot}deg)` }} viewBox="0 0 100 100">
      <path d="M50 0 C54 34 66 46 100 50 C66 54 54 66 50 100 C46 66 34 54 0 50 C34 46 46 34 50 0 Z" fill={color} />
    </svg>
  );
}

function Squiggle({ pos, width, rot, c1, c2, opacity = 1 }: { pos: Pos; width: number; rot: number; c1: string; c2: string; opacity?: number }) {
  const id = `sq${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="deco" style={{ ...pos, width, height: width * 0.34, opacity, transform: `rotate(${rot}deg)` }} viewBox="-8 -8 216 76">
      <defs><linearGradient id={id}><stop offset="0" stopColor={c1} /><stop offset="1" stopColor={c2} /></linearGradient></defs>
      <path d="M0 30 Q25 0 50 30 T100 30 T150 30 T200 30" fill="none" stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}

const orb = (pos: Pos, d: number, color: string, opacity: number): CSSProperties => ({ ...pos, width: d, height: d, opacity, background: `radial-gradient(circle, ${color} 0%, ${color}00 68%)` });
const capsule = (pos: Pos, w: number, h: number, rot: number, c1: string, c2: string, opacity = 1): CSSProperties =>
  ({ ...pos, width: w, height: h, opacity, '--rot': `${rot}deg`, background: `linear-gradient(90deg, ${c1}, ${c2})`, '--glow': `${c2}59` } as CSSProperties);
const ring = (pos: Pos, d: number, rot: number, opacity = 1): CSSProperties => ({ ...pos, width: d, height: d, opacity, '--rot': `${rot}deg` } as CSSProperties);
const bubble = (pos: Pos, d: number, color: string): CSSProperties => ({ ...pos, width: d, height: d, background: `linear-gradient(180deg, #fff, ${color})`, '--glow': `${color}59` } as CSSProperties);

export function Decor({ variant }: { variant: 'hero' | 'app' | 'stage' | 'phone' | 'done' }) {
  if (variant === 'hero') {
    return (
      <div className="decor" aria-hidden>
        <div className="hero-grid" />
        <div className="deco orb" style={orb({ left: '20%', top: '-300px' }, 780, C.violet, 0.55)} />
        <div className="deco orb" style={orb({ left: '50%', top: '-220px' }, 580, C.pink, 0.32)} />
        <div className="deco orb" style={orb({ left: '34%', top: '140px' }, 540, C.cyan, 0.16)} />
        <Prism pos={{ left: '4%', top: '190px' }} size={176} rot={-14} c1={C.violet} c2={C.pink} float={1} />
        <Squiggle pos={{ left: '3.5%', top: '540px' }} width={210} rot={10} c1={C.cyan} c2={C.blue} />
        <div className="deco ring float-2" style={ring({ right: '8%', top: '150px' }, 150, 18)} />
        <div className="deco capsule float-3" style={capsule({ right: '6%', top: '470px' }, 196, 70, -24, C.amber, C.pink)} />
        <Sparkle pos={{ left: '21%', top: '110px' }} size={28} color={C.amber} rot={10} />
        <Sparkle pos={{ right: '22%', top: '92px' }} size={20} color={C.cyan} />
        <Sparkle pos={{ right: '6.5%', top: '404px' }} size={24} color={C.pink} rot={20} />
        <Sparkle pos={{ left: '15%', top: '440px' }} size={16} color="#fff" opacity={0.8} />
        <div className="deco bubble float-2" style={bubble({ right: '3.5%', top: '250px' }, 22, C.violet)} />
        <div className="deco bubble float-1" style={bubble({ left: '19%', top: '330px' }, 14, C.amber)} />
        <div className="deco ball-wrap" style={{ right: '9%', top: '600px' }}>
          <div className="ball" />
          <div className="ball-shadow" />
        </div>
      </div>
    );
  }
  if (variant === 'stage') {
    return (
      <div className="decor" aria-hidden>
        <div className="deco orb" style={orb({ right: '-10%', top: '-300px' }, 760, C.violet, 0.42)} />
        <div className="deco orb" style={orb({ left: '-14%', top: '520px' }, 560, C.cyan, 0.18)} />
        <div className="deco orb" style={orb({ right: '0%', top: '620px' }, 480, C.pink, 0.16)} />
        <Prism pos={{ right: '3%', top: '22px' }} size={110} rot={-18} c1={C.violet} c2={C.pink} opacity={0.9} float={1} />
        <Sparkle pos={{ right: '14%', top: '40px' }} size={18} color={C.cyan} />
        <div className="deco bubble" style={bubble({ right: '2%', top: '170px' }, 14, C.amber)} />
      </div>
    );
  }
  if (variant === 'phone') {
    return (
      <div className="decor" aria-hidden>
        <div className="deco orb" style={orb({ left: '10%', top: '-200px' }, 420, C.violet, 0.4)} />
        <div className="deco orb" style={orb({ right: '-30%', top: '380px' }, 380, C.cyan, 0.14)} />
      </div>
    );
  }
  if (variant === 'done') {
    return (
      <div className="decor" aria-hidden>
        <div className="deco orb" style={orb({ left: '0%', top: '-160px' }, 460, '#45DB8C', 0.3)} />
        <Sparkle pos={{ right: '18%', top: '90px' }} size={16} color="#45DB8C" />
        <Sparkle pos={{ left: '16%', top: '150px' }} size={10} color="#fff" opacity={0.7} />
      </div>
    );
  }
  return (
    <div className="decor" aria-hidden>
      <div className="deco orb" style={orb({ right: '-8%', top: '-320px' }, 760, C.violet, 0.42)} />
      <div className="deco orb" style={orb({ left: '-8%', bottom: '-260px' }, 600, C.cyan, 0.2)} />
      <div className="deco orb" style={orb({ left: '40%', top: '-380px' }, 540, C.pink, 0.16)} />
      <Prism pos={{ right: '3%', bottom: '60px' }} size={190} rot={-16} c1={C.violet} c2={C.pink} opacity={0.5} float={1} />
      <div className="deco ring" style={ring({ left: '42%', bottom: '-70px' }, 170, 24, 0.35)} />
      <div className="deco capsule" style={capsule({ left: '24%', top: '-24px' }, 170, 60, -14, C.amber, C.pink, 0.3)} />
    </div>
  );
}
