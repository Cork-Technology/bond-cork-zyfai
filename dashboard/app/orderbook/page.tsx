"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listPools, listOrderbook, listFills } from "@/lib/api";
import { KNOWN_POOLS, arbiscanTx } from "@/lib/constants";
import { truncate } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, BookOpen } from "lucide-react";
import type { LimitOrder, Fill } from "@/lib/types";

function OrderTable({
  title,
  orders,
  side,
}: {
  title: string;
  orders: LimitOrder[];
  side: "BUY" | "SELL";
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // {side}
          </span>
          {title}
          <Badge variant="outline" className="font-mono text-[10px]">
            {orders.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-mono text-[10px] uppercase">Maker</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Premium</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Making</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Taking</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Remaining</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No {side.toLowerCase()} orders
                </TableCell>
              </TableRow>
            ) : (
              orders.map((order) => (
                <TableRow key={order.orderHash}>
                  <TableCell className="font-mono text-xs">{truncate(order.maker)}</TableCell>
                  <TableCell className="font-mono text-xs">{order.premium} bps</TableCell>
                  <TableCell className="font-mono text-xs">{order.makingAmount}</TableCell>
                  <TableCell className="font-mono text-xs">{order.takingAmount}</TableCell>
                  <TableCell className="font-mono text-xs">{order.remainingMakingAmount}</TableCell>
                  <TableCell>
                    <Badge
                      variant={order.status === "OPEN" || order.status === "PARTIALLY_FILLED" ? "default" : "secondary"}
                      className="font-mono text-[10px] uppercase"
                    >
                      {order.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FillsTable({ fills }: { fills: Fill[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // FILLS
          </span>{" "}
          Recent fills
        </CardTitle>
        <CardDescription>On-chain settlement history for this pool</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-mono text-[10px] uppercase">Tx hash</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Taker</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Making</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Taking</TableHead>
              <TableHead className="font-mono text-[10px] uppercase">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fills.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No fills yet
                </TableCell>
              </TableRow>
            ) : (
              fills.map((fill) => (
                <TableRow key={`${fill.orderHash}-${fill.txHash}`}>
                  <TableCell>
                    <a
                      href={arbiscanTx(fill.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-accent-on-dark hover:underline"
                    >
                      {truncate(fill.txHash)}
                      <ExternalLink className="size-3" />
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{truncate(fill.taker)}</TableCell>
                  <TableCell className="font-mono text-xs">{fill.makingAmount}</TableCell>
                  <TableCell className="font-mono text-xs">{fill.takingAmount}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {new Date(fill.blockTimestamp).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function OrderbookPage() {
  const [selectedPoolId, setSelectedPoolId] = useState<string>(
    KNOWN_POOLS.sUSDe_yoUSD
  );

  const { data: pools, isLoading: poolsLoading } = useQuery({
    queryKey: ["pools"],
    queryFn: listPools,
  });

  const { data: book, isLoading: bookLoading } = useQuery({
    queryKey: ["orderbook", selectedPoolId],
    queryFn: () => listOrderbook(selectedPoolId),
    enabled: !!selectedPoolId,
  });

  const { data: fills, isLoading: fillsLoading } = useQuery({
    queryKey: ["fills", selectedPoolId],
    queryFn: () => listFills(selectedPoolId),
    enabled: !!selectedPoolId,
  });

  const selectedPool = useMemo(
    () => pools?.find((p) => p.poolId === selectedPoolId),
    [pools, selectedPoolId]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // ORDERBOOK
          </span>
          <h1 className="font-display text-3xl font-bold tracking-tight text-foreground">
            Live market book
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Phoenix limit orders and on-chain fills for the selected pool.
          </p>
        </div>
        {poolsLoading ? (
          <Skeleton className="h-10 w-56" />
        ) : (
          <Select
            value={selectedPoolId}
            onValueChange={(value) => value && setSelectedPoolId(value)}
          >
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select pool" />
            </SelectTrigger>
            <SelectContent>
              {pools?.map((pool) => (
                <SelectItem key={pool.poolId} value={pool.poolId}>
                  {pool.collateralToken.symbol} / {pool.referenceToken.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selectedPool && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px]">
            {selectedPool.collateralToken.symbol} / {selectedPool.referenceToken.symbol}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {truncate(selectedPool.poolId)}
          </Badge>
          <span className="font-mono text-xs">CA {truncate(selectedPool.collateralToken.address)}</span>
          <span className="font-mono text-xs">REF {truncate(selectedPool.referenceToken.address)}</span>
        </div>
      )}

      {bookLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <OrderTable
            title="Cover requests"
            orders={book?.bids ?? []}
            side="BUY"
          />
          <OrderTable
            title="Cover offers"
            orders={book?.asks ?? []}
            side="SELL"
          />
        </div>
      )}

      {fillsLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <FillsTable fills={fills ?? []} />
      )}
    </div>
  );
}
