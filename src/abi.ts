// ABIs extracted from forge build of the contracts repo at ad0f0b417c11d8c713641351b76afdc2fa5bf57f.
import armsJson from "./abi/Arms.json" with { type: "json" };
import courtJson from "./abi/IMDCourt.json" with { type: "json" };
import formsJson from "./abi/ArmsForms.json" with { type: "json" };
import tokenJson from "./abi/MockToken.json" with { type: "json" };
import type { Abi } from "viem";

export const armsAbi = armsJson as Abi;
export const courtAbi = courtJson as Abi;
export const formsAbi = formsJson as Abi;
export const erc20Abi = tokenJson as Abi;

export const PHASES = ["NONE", "OPEN", "COMMIT", "REVEAL", "TIE_OPEN", "TIE_COMMIT", "TIE_REVEAL", "SETTLED", "CANCELLED"] as const;
export const STATUSES = ["NONE", "AGREED", "MAJORITY", "UNRESOLVED", "CORRECTED", "OVERTURNED"] as const;
export const RULINGS = ["NONE", "STORED", "CLAIMED", "NEITHER"] as const;
