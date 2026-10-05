import "server-only";
import fs from "node:fs";
import path from "node:path";
import { GATEWAY_DIR } from "./config";
import type { Role } from "@/lib/core/ledger";

export type EnrolRequest = {
  userId: string;
  name: string;
  org: string;
  dsaPk: string;
  kemPk: string;
  popSig: string;
  requestedRoles: Role[];
  note: string;
  submittedAt: number;
};

const FILE = path.join(GATEWAY_DIR, "enrolments.json");

function load(): EnrolRequest[] {
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function save(list: EnrolRequest[]) {
  fs.mkdirSync(GATEWAY_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

export const listEnrolments = load;

export function addEnrolment(r: EnrolRequest) {
  const list = load().filter((x) => x.userId !== r.userId);
  if (list.length > 500) throw new Error("too many pending enrolments");
  save([...list, r]);
}

export function removeEnrolment(userId: string) {
  save(load().filter((x) => x.userId !== userId));
}
