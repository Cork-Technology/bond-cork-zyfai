"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Workflow,
  BookOpen,
  Handshake,
  ShieldCheck,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/workflow", label: "Workflow", icon: Workflow },
  { href: "/orderbook", label: "Orderbook", icon: BookOpen },
  { href: "/negotiate", label: "Request cover", icon: Handshake },
  { href: "/underwrite", label: "Provide cover", icon: ShieldCheck },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 z-40 flex h-16 w-full items-center border-b border-[var(--hairline-dark)] bg-card px-4 lg:h-screen lg:w-64 lg:flex-col lg:items-start lg:justify-start lg:border-b-0 lg:border-r lg:px-0 lg:py-6">
      <div className="flex items-center gap-3 px-0 lg:px-6">
        <div className="flex size-8 items-center justify-center rounded-[var(--radius-brand)] bg-primary text-primary-foreground font-mono text-sm font-bold">
          B
        </div>
        <div className="hidden lg:block">
          <span className="block font-display text-lg font-bold leading-none text-card-foreground">
            bond.credit
          </span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // Cork × Zyfai
          </span>
        </div>
      </div>

      <nav className="flex flex-1 items-center gap-1 overflow-x-auto px-2 lg:mt-8 lg:flex-col lg:px-4">
        {links.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius-brand)] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors command",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              <span className="hidden lg:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
