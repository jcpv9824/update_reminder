import { useState } from "react";
import { apiUrl } from "../api/client";

const fallback = { login: "/brand/sag-two-tone-icon.png", sidebar: "/brand/sag-white-icon.png" } as const;

export default function LogoPortal({ uso, className }: { uso: keyof typeof fallback; className?: string }) {
  const [usarRespaldo, setUsarRespaldo] = useState(false);
  return <img src={usarRespaldo ? fallback[uso] : apiUrl(`/public/brand/${uso}`)} alt="SAG"
    className={className} onError={() => setUsarRespaldo(true)} />;
}
