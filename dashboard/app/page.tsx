import { Suspense } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Workflow,
  BookOpen,
  Handshake,
  BarChart3,
  ExternalLink,
} from "lucide-react";
import { SAFE_ADDRESS, BOND_ADDRESS, CONTRACTS } from "@/lib/constants";

const sections = [
  {
    href: "/workflow",
    title: "Ceremony Workflow",
    description: "Trace the sUSDe-yoUSD market creation, approvals, bids, lifts and exercises.",
    icon: Workflow,
  },
  {
    href: "/orderbook",
    title: "Orderbook",
    description: "Live Phoenix orderbook and fills per pool.",
    icon: BookOpen,
  },
  {
    href: "/negotiate",
    title: "Negotiate",
    description: "Compare Safe bids against Bond asks and prepare matching actions.",
    icon: Handshake,
  },
  {
    href: "/analytics",
    title: "Analytics",
    description: "Bond underwriting exposure, yield curve and portfolio history.",
    icon: BarChart3,
  },
];

function AddressRow({
  label,
  address,
  href,
}: {
  label: string;
  address: string;
  href: string;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-xs break-all hover:underline"
      >
        {address}
        <ExternalLink className="size-3 shrink-0" />
      </a>
    </div>
  );
}

function EnvCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Environment</CardTitle>
        <CardDescription>
          Live Arbitrum addresses used by this observer dashboard
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <AddressRow
          label="Safe (M2 operator)"
          address={SAFE_ADDRESS}
          href={`https://arbiscan.io/address/${SAFE_ADDRESS}`}
        />
        <AddressRow
          label="Bond agent"
          address={BOND_ADDRESS}
          href={`https://arbiscan.io/address/${BOND_ADDRESS}`}
        />
        <AddressRow
          label="Cork Pool Manager"
          address={CONTRACTS.POOL_MANAGER}
          href={`https://arbiscan.io/address/${CONTRACTS.POOL_MANAGER}`}
        />
        <AddressRow
          label="Limit Order Protocol"
          address={CONTRACTS.LOP}
          href={`https://arbiscan.io/address/${CONTRACTS.LOP}`}
        />
        <AddressRow
          label="Cork Adapter"
          address={CONTRACTS.ADAPTER}
          href={`https://arbiscan.io/address/${CONTRACTS.ADAPTER}`}
        />
        <AddressRow
          label="Market Creator"
          address={CONTRACTS.MARKET_CREATOR}
          href={`https://arbiscan.io/address/${CONTRACTS.MARKET_CREATOR}`}
        />
      </CardContent>
    </Card>
  );
}

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Bond.credit × Cork × Zyfai
        </h1>
        <p className="text-muted-foreground">
          Hackathon demo observer dashboard — Phase 1 (read-only)
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sections.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon className="size-5 text-muted-foreground group-hover:text-foreground" />
                  {title}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Suspense
        fallback={
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <EnvCard />
      </Suspense>
    </div>
  );
}
