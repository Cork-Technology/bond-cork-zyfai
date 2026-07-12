import { createConfig, cookieStorage, createStorage, http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import { injected, walletConnect } from "@wagmi/connectors";

export const projectId =
  process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "b56e18d47c72ab683b10814fe9495694";

export const chains = [arbitrum] as const;

export const config = createConfig({
  chains,
  connectors: [
    injected(),
    walletConnect({
      projectId,
      metadata: {
        name: "Bond × Cork × Zyfai Dashboard",
        description: "Hackathon demo dashboard for Cork Phoenix coverage markets",
        url: typeof window !== "undefined" ? window.location.origin : "http://localhost:3001",
        icons: [],
      },
      showQrModal: true,
    }),
  ],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: {
    [arbitrum.id]: http(),
  },
});
