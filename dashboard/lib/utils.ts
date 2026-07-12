import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function truncate(addr?: string, start = 6, end = 4) {
  if (!addr) return "—";
  return `${addr.slice(0, start)}…${addr.slice(-end)}`;
}
