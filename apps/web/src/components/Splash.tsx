import "./splash.css";
import { BASE } from "../api";
import { useRadar } from "../store";

export function Splash({ fading }: { fading: boolean }): JSX.Element {
  const captain = useRadar((s) => s.config?.brand.captainUrl) ?? `${BASE}/brand/CaptainQIcon-BGRVD.PNG`;

  return (
    <div className={`splash${fading ? " splash--hide" : ""}`} aria-hidden>
      {/* Background network of connecting lines */}
      <svg className="splash-net" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
        <g className="net-lines">
          <line x1="120" y1="180" x2="500" y2="500" />
          <line x1="880" y1="160" x2="500" y2="500" />
          <line x1="170" y1="820" x2="500" y2="500" />
          <line x1="850" y1="840" x2="500" y2="500" />
          <line x1="120" y1="180" x2="880" y2="160" />
          <line x1="170" y1="820" x2="850" y2="840" />
          <line x1="60" y1="500" x2="500" y2="500" />
          <line x1="940" y1="500" x2="500" y2="500" />
        </g>
        <g className="net-nodes">
          <circle cx="120" cy="180" r="5" />
          <circle cx="880" cy="160" r="5" />
          <circle cx="170" cy="820" r="5" />
          <circle cx="850" cy="840" r="5" />
          <circle cx="60" cy="500" r="4" />
          <circle cx="940" cy="500" r="4" />
        </g>
      </svg>

      {/* Radar scope */}
      <div className="scope">
        <span className="ring r1" />
        <span className="ring r2" />
        <span className="ring r3" />
        <span className="cross cross-h" />
        <span className="cross cross-v" />
        <span className="sweep" />
        <span className="blip b1" />
        <span className="blip b2" />
        <span className="blip b3" />
        <img className="scope-captain" src={captain} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
      </div>

      {/* Plane flying across */}
      <span className="splash-plane">✈</span>

      <div className="splash-word">
        <span className="w-q">QDRN</span> <span className="w-r">RADAR</span>
      </div>
      <div className="splash-sub">
        Acquiring aircraft<span className="ell" />
      </div>
      <div className="splash-bar"><span /></div>
    </div>
  );
}
