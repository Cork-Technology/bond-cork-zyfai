import { createPublicClient, http, formatUnits } from "viem";
import { arbitrum } from "viem/chains";
import { RPC_URL, CHAIN_ID } from "@/lib/constants";

export const publicClient = createPublicClient({
  chain: CHAIN_ID === 42161 ? arbitrum : arbitrum,
  transport: http(RPC_URL),
});

export { CHAIN_ID };

export function formatToken(value: bigint, decimals: number) {
  return formatUnits(value, decimals);
}

export async function detectAccountType(
  address: `0x${string}`,
  provider?: { request: (args: { method: string; params: unknown[] }) => Promise<unknown> }
): Promise<"EOA" | "CONTRACT"> {
  try {
    let code: string | undefined;
    if (provider) {
      code = (await provider.request({ method: "eth_getCode", params: [address, "latest"] })) as string;
    } else if (typeof window !== "undefined" && (window as any).ethereum?.request) {
      code = (await (window as any).ethereum.request({
        method: "eth_getCode",
        params: [address, "latest"],
      })) as string;
    } else {
      code = await publicClient.getBytecode({ address });
    }
    return code && code !== "0x" ? "CONTRACT" : "EOA";
  } catch {
    return "EOA";
  }
}
