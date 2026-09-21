import { Icons } from "./icons.ts";

export type IconName = keyof typeof Icons;

export interface IconDefinition {
  paths: Array<{ d: string; class?: string; fill?: string }>;
  class?: string;
  height?: number;
  width?: number;
  viewBox: string;
  fill?: string;
  title?: string;
  clipRule?: "inherit" | "evenodd" | "nonzero";
  fillRule?: "inherit" | "evenodd" | "nonzero";
  stroke?: string;
  strokeWidth?: number | string;
  strokeLinecap?: "inherit" | "butt" | "round" | "square";
  strokeLinejoin?: "inherit" | "round" | "miter" | "bevel";
}

export function resolveIcon(name: string): IconDefinition {
  if (!Object.hasOwn(Icons, name)) {
    throw new Error(`Unknown icon: ${name}`);
  }
  return Icons[name as IconName] as unknown as IconDefinition;
}
