import { NextResponse } from "next/server";
import { getGenesis } from "@/lib/server/config";
import { guard } from "@/lib/server/http";
import { ALG } from "@/lib/core/pq";

// Public network parameters the browser needs to encrypt and verify.
export const GET = guard(async () => {
  const g = getGenesis();
  return NextResponse.json({
    chainId: g.chainId,
    network: g.body.network,
    quorum: g.body.quorum,
    shareThreshold: g.body.shareThreshold,
    validators: g.body.validators.map((v) => ({ id: v.id, name: v.name, kemPk: v.kemPk, dsaPk: v.dsaPk })),
    registrars: g.body.registrars,
    gateway: g.body.gateway,
    algorithms: ALG,
    genesis: g,
  });
});
