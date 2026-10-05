import { NextResponse } from "next/server";
import { guard } from "@/lib/server/http";
import { nodeStatuses, query } from "@/lib/server/ledger-client";
import { vaultStats } from "@/lib/server/vault-store";
import { wmHealth } from "@/lib/server/wm-client";
import { getGenesis } from "@/lib/server/config";

export const GET = guard(async () => {
  const [nodes, summary, wm] = await Promise.all([
    nodeStatuses(),
    query<Record<string, number>>("/state/summary", 2000).catch(() => null),
    wmHealth(),
  ]);
  const g = getGenesis();
  return NextResponse.json({ chainId: g.chainId, quorum: g.body.quorum, nodes, summary, vault: vaultStats(), watermarkEngine: wm });
});
