import React, {
  createContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
  useCallback,
} from "react";
import { getKeyFromPassword, encrypt, decrypt } from "dha-encryption";
import browser from "webextension-polyfill";
import { defaultNodes } from "../config/nodes";
import { accountPreferencesKey, parseStringList, type AccountPreferences } from "../utils/accountPreferences";
import { setSessionAccountIndex } from "../mobile-port/utils/sessionVault";
import {
  DEFAULT_NODE_INDEX,
  type NodeGroups,
  type NodeNetwork,
  type NodeSelection,
  type WalletNode,
} from "../config/network";
import {
  defaultSelection,
  familyLabel,
  familyOfUrl,
  flattenNodeGroups,
  groupNodeRecords,
  networkLabel,
  nodeForFamily,
  normalizeNodeUrl,
  otherNetwork,
} from "../utils/nodes";
import {
  deriveAccountAtIndex,
  deriveWallet,
  generateWallet,
  importFromPrivateKey,
  type PathType,
  type WalletKeyMaterial,
  type WordCount,
} from "../utils/walletKeys";
import {
  connectLedgerAccount,
  type LedgerSession,
} from "../ledger/warthogApp";
import {
  clearLedgerSession,
  consumeLedgerHandoff,
  consumeLedgerPopupArm,
  ledgerHandoffPending,
  readLedgerSession,
  rememberLedgerBookmark,
  renameLedgerBookmark,
  saveLedgerBookmark,
  saveLedgerSession,
} from "../ledger/session";
import { isToolbarActionPopup as isLedgerToolbarPopup } from "../ledger/shell";
import {
  decryptWallet,
  encryptWallet,
  loadNamedWalletEncrypted,
  saveNamedWallet,
  type EncryptedWalletPayload,
} from "../utils/warthogWalletCrypto";
import {
  buildEnvelopeWithPasskey,
  decryptWithPasskey,
  envelopeWithPassword,
  inspectWalletBlob,
  isWebAuthnAvailable,
  serializeEnvelope,
  setPasskeyProductName,
  tryParseEnvelope,
  unlockEnvelopeWith2fa,
} from "../utils/passkeyWallet";
import {
  activateWorkerAccount,
  bumpIdleTimer,
  exportWalletFromWorker,
  getSigningStatus,
  lockSigningWorker,
  setIdleLockHandler,
  unlockSigningWorker,
} from "../utils/signingBridge";
import {
  askBackgroundToReopenToolbar,
  clearPasskeyJob,
  clearToolbarUnlock,
  handOffPasskeyJob,
  isToolbarActionPopup,
  readPasskeyJob,
  readToolbarUnlock,
  storeToolbarUnlock,
} from "../utils/passkeyHandoff";
import { isOpaqueSessionToken, newSessionToken } from "../utils/sessionToken";

setPasskeyProductName("Warthog Extension");

interface WalletContextProps {
  seedPhrase: string | null;
  /** Active account private key (hex). Required for PK-only wallets; also set for seed wallets. */
  privateKey: string | null;
  wallet: string | null;
  walletList: string[];
  nameList: string[];
  nodeList: WalletNode[];
  /** The node the wallet is talking to, with the family it belongs to. */
  selectedNode: WalletNode | null;
  visibleWalletList: boolean[];
  selectedWalletIndex: number;
  selectedNodeIndex: number;
  password: string | null;
  name: string | null;
  /** Named save used to authenticate this session, independent of account labels. */
  savedWalletName: string | null;
  pathType: PathType;
  tmpDestinationWallet: string | null;
  tmpAssetHash: string | null;
  tmpTokenAmount: string | null;
  tmpWartAmount: string | null;
  tmpLimitPrice: string | null;
  tmpPrecision: number;
  tmpCancelHeight: number | null;
  tmpCancelNonceId: number | null;
  tmpTokenName: string | null;
  tmpTransferType: "wart" | "token" | "liquidity";
  tmpTradeType: "buy" | "sell";
  tmpLiquidityType: "add" | "remove";
  inputWordsBackup: string[];
  selectedNodeUrl: string | null;
  /** The node chosen in each family, by URL. */
  selectedNodeUrls: NodeSelection;
  /** The family the wallet is talking to, from the selected node. */
  activeNetwork: NodeNetwork;
  /**
   * Set when a switch found no node for the family it was going to.
   *
   * The slot is emptied in that case, so the state says there is no node.
   * The message says which family is empty, and the card shows it next to
   * the other node errors.
   */
  nodeError: string | null;
  selectedNetworkLabel: "Mainnet" | "DeFi Testnet";
  /** True when setup is complete enough to show the home UI. */
  isAuthenticated: boolean;
  /** Set when the open session is the Nano Warthog app. No private key is stored. */
  ledgerAccount: LedgerSession | null;
  loginWithLedger: (
    pathType?: PathType,
    accountName?: string,
    accountIndex?: number,
    expectedAddress?: string,
  ) => Promise<void>;
  /** Seed-based wallets can add more accounts; PK-only cannot. */
  canAddAccounts: boolean;
  setName: (name: string) => void;
  setSeedPhrase: (seedPhrase: string | null) => void;
  setPrivateKey: (privateKey: string | null) => void;
  setWallet: (wallet: string) => void;
  setPassword: (password: string) => void;
  setWalletList: (walletList: string[]) => void;
  setNodeList: (nodeList: WalletNode[]) => void;
  setNameList: (nameList: string[]) => void;
  /** Select a node by its URL. The index is derived from it. */
  setSelectedNodeUrl: (selectedNodeUrl: string, network?: NodeNetwork) => void;
  /**
   * Move to the other family's node.
   *
   * Both families keep their own selection, so a round trip returns to the
   * node that was in use before.
   */
  switchNetwork: () => void;
  /**
   * Move to a family, using the node remembered for it.
   *
   * The node picker's tabs call this: picking the DeFi testnet tab moves the
   * wallet to the DeFi testnet.
   */
  setActiveNetwork: (network: NodeNetwork) => void;
  setVisibleWalletList: (visibleWalletList: boolean[]) => void;
  setSelectedWalletIndex: (selectedWalletIndex: number) => void;
  setInputWordsBackup: (inputWordsBackup: string[]) => void;
  setPathType: (pathType: PathType) => void;
  clearWalletData: () => void;
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
  /** Wipe in-memory keys and session token. Named encrypted wallets stay on disk. */
  lockSession: () => Promise<void>;
  accountPath: (index: number) => string;
  newWallet: (wordCount?: WordCount, pathType?: PathType) => Promise<void>;
  addAccount: (name: string | null) => Promise<void>;
  switchActiveAccount: (index: number) => Promise<void>;
  importWallet: (
    seedPhrase: string,
    pathType?: PathType,
    wordCount?: WordCount,
  ) => Promise<void>;
  importPrivateKey: (privateKeyHex: string) => Promise<void>;
  /** Activate from website-compatible encrypted payload (saved wallet / file). */
  loginFromEncrypted: (
    encrypted: string,
    password: string,
    walletName?: string | null,
  ) => Promise<void>;
  /** False until a pending toolbar unlock, if any, has been applied. */
  sessionReady: boolean;
  /**
   * True once the stored token has been read.
   *
   * The token is read from storage asynchronously, so for a while there is
   * a token and no session, which is not the same as no session at all.
   * The app needs to tell the two apart before it treats the absence of a
   * token as an ended session.
   */
  tokenLoaded: boolean;
  /** Finish a passkey save/unlock that was moved out of the toolbar popup. */
  resumePasskeyHandoff: () => Promise<void>;
  /** Open the toolbar dropdown again and close the passkey window. */
  finishPasskeyInToolbar: () => Promise<boolean>;
  /** Unlock a multi-auth envelope with WebAuthn passkey (optionally + password for 2FA). */
  loginFromPasskey: (
    encrypted: string,
    walletName?: string | null,
    password?: string | null,
  ) => Promise<void>;
  /** Persist current key material as a named wallet (website format). */
  saveCurrentAsNamedWallet: (
    walletName: string,
    password?: string | null,
    opts?: {
      withPasskey?: boolean;
      require2fa?: boolean;
      preferFingerprint?: boolean;
    },
  ) => Promise<void>;
  /** Add or re-register passkey unlock on the currently open named wallet. */
  enablePasskeyOnCurrentWallet: (opts?: {
    password?: string | null;
    require2fa?: boolean;
    preferFingerprint?: boolean;
    name?: string | null;
  }) => Promise<boolean>;
  activateKeyMaterial: (
    data: WalletKeyMaterial,
    opts?: { password?: string; name?: string; savedWalletName?: string | null },
  ) => Promise<void>;
  setWalletListState: (walletList: string[]) => void;
  setNodeListState: (nodeList: WalletNode[]) => void;
  setNameListState: (nameList: string[]) => void;
  setSelectedWalletIndexState: (selectedWalletIndex: number) => void;
  setSelectedNodeUrlsState: (selectedNodeUrls: NodeSelection) => void;
  setVisibleWalletListState: (visibleWalletList: boolean[]) => void;
  setTmpDestinationWalletState: (tmpDestinationWallet: string) => void;
  setTmpAssetHashState: (tmpAssetHash: string) => void;
  setTmpTokenAmountState: (tmpTokenAmount: string) => void;
  setTmpWartAmountState: (tmpWartAmount: string) => void;
  setTmpLimitPriceState: (tmpLimitPrice: string) => void;
  setTmpPrecisionState: (tmpPrecision: number) => void;
  setTmpCancelHeightState: (tmpCancelHeight: number) => void;
  setTmpCancelNonceIdState: (tmpCancelNonceId: number) => void;
  setTmpTokenNameState: (tmpTokenName: string) => void;
  setTmpTransferTypeState: (
    tmpTransferType: "wart" | "token" | "liquidity",
  ) => void;
  refreshTokenExpiration: () => void;
  setTmpTradeTypeState: (tmpTradeType: "buy" | "sell") => void;
  setTmpLiquidityTypeState: (tmpLiquidityType: "add" | "remove") => void;
  signingUnlocked: boolean;
}

const WalletContext = createContext<WalletContextProps | undefined>(undefined);

const ENCRYPTION_KEY =
  import.meta.env.VITE_APP_ENCRYPTION_KEY || "encryption_key";

export const WalletProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [seedPhrase, setSeedPhraseState] = useState<string | null>(null);
  const [privateKey, setPrivateKeyState] = useState<string | null>(null);
  const [wallet, setWalletState] = useState<string | null>(null);
  const [password, setPasswordState] = useState<string | null>(null);
  const [name, setNameState] = useState<string | null>(null);
  const [savedWalletName, setSavedWalletName] = useState<string | null>(null);
  const [pathType, setPathTypeState] = useState<PathType>("hardened");
  const [walletList, setWalletListState] = useState<string[]>([]);
  const [selectedWalletIndex, setSelectedWalletIndexState] =
    useState<number>(0);
  const [selectedNodeUrls, setSelectedNodeUrlsState] = useState<NodeSelection>({
    mainnet: "",
    "defi-testnet": "",
  });
  // Which family the wallet is talking to. The node for that family comes
  // out of the pair above.
  const [activeNetworkKey, setActiveNetworkKeyState] =
    useState<NodeNetwork>("mainnet");
  const [nameList, setNameListState] = useState<string[]>([]);
  const [nodeList, setNodeListState] = useState<WalletNode[]>([]);
  const [token, setTokenState] = useState<string | null>(null);
  const [signingUnlocked, setSigningUnlocked] = useState(false);
  const [ledgerAccount, setLedgerAccount] = useState<LedgerSession | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  // Whether the stored token has been read. The read is asynchronous, so
  // this is what tells "no session" apart from "not looked yet".
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const toolbarUnlockRef = useRef<{
    privateKey: string;
    publicKey: string;
    address: string;
    mnemonic?: string;
    pathType?: PathType;
    password: string | null;
    name: string;
    savedWalletName?: string | null;
  } | null>(null);
  const [hasMnemonic, setHasMnemonic] = useState(false);
  const accountRootRef = useRef<string | null>(null);
  const [visibleWalletList, setVisibleWalletListState] = useState<boolean[]>(
    [],
  );
  const [tmpDestinationWallet, setTmpDestinationWalletState] = useState<
    string | null
  >(null);
  const [tmpAssetHash, setTmpAssetHashState] = useState<string | null>(null);
  const [tmpTokenAmount, setTmpTokenAmountState] = useState<string | null>(
    null,
  );
  const [tmpWartAmount, setTmpWartAmountState] = useState<string | null>(null);
  const [tmpLimitPrice, setTmpLimitPriceState] = useState<string | null>(null);
  const [tmpPrecision, setTmpPrecisionState] = useState<number>(8);
  const [tmpCancelHeight, setTmpCancelHeightState] = useState<number | null>(
    null,
  );
  const [tmpCancelNonceId, setTmpCancelNonceIdState] = useState<number | null>(
    null,
  );
  const [tmpTokenName, setTmpTokenNameState] = useState<string | null>(null);
  const [tmpTransferType, setTmpTransferTypeState] = useState<
    "wart" | "token" | "liquidity"
  >("wart");
  const [tmpTradeType, setTmpTradeTypeState] = useState<"buy" | "sell">("buy");
  const [tmpLiquidityType, setTmpLiquidityTypeState] = useState<
    "add" | "remove"
  >("add");
  const [inputWordsBackup, setInputWordsBackupState] = useState<string[]>([]);

  const arrayBufferToHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };

  const hexToArrayBuffer = (hex: string): ArrayBuffer => {
    const bytes = new Uint8Array(
      hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    return bytes.buffer;
  };

  // Memoized with an empty dep array on purpose: both close only over
  // module-level ENCRYPTION_KEY and the imported crypto helpers, so their
  // identity is genuinely constant. That stability is what lets the effects
  // and callbacks below list them as dependencies without re-running every
  // render.
  const saveToBrowserStorage = useCallback(
    async (key: string, value: string | null): Promise<void> => {
      try {
        const keyObject = await getKeyFromPassword(ENCRYPTION_KEY);
        const encryptedValue = value ? await encrypt(value, keyObject) : null;
        const hexValue = encryptedValue
          ? arrayBufferToHex(encryptedValue)
          : null;
        await browser.storage.local.set({ [key]: hexValue });
      } catch (error) {
        console.error(`Error saving ${key} to browser storage:`, error);
        throw error;
      }
    },
    [],
  );

  const decryptValue = useCallback(
    async (value: string | undefined): Promise<string | null> => {
      const keyObject = await getKeyFromPassword(ENCRYPTION_KEY);
      const arrayBuffer = value ? hexToArrayBuffer(value) : null;
      const decryptedValue = arrayBuffer
        ? await decrypt(arrayBuffer, keyObject)
        : null;
      return decryptedValue;
    },
    [],
  );

  const loadFromChromeStorage = useCallback(
    (key: string, callback: (value: string | null) => void): void => {
      try {
        browser.storage.local
          .get(key)
          .then((result: Record<string, unknown>) => {
            decryptValue(result[key] as string | undefined)
              .then((decryptedValue) => {
                callback(decryptedValue);
              })
              .catch((error: unknown) => {
                console.error(
                  `Error decrypting ${key} from browser storage:`,
                  error,
                );
              });
          })
          .catch((error: unknown) => {
            console.error(`Error loading ${key} from browser storage:`, error);
          });
      } catch (error) {
        console.error(`Error loading ${key} from browser storage:`, error);
      }
    },
    [decryptValue],
  );

  const accountPath = (index: number): string => {
    return pathType === "hardened"
      ? `m/44'/2070'/0'/0/${index}`
      : `m/44'/2070'/0/0/${index}`;
  };

  const ensureDefaultNodes = () => {
    setNodeList(defaultNodes);
    setSelectedNodeUrl(defaultNodes[0].url);
  };

  const setPrivateKey = (pk: string | null): void => {
    setPrivateKeyState(pk);
  };

  const setPathType = (pt: PathType): void => {
    setPathTypeState(pt);
    saveToBrowserStorage("pathType", pt);
  };

  const setSeedPhrase = (seed: string | null): void => {
    setSeedPhraseState(seed);
  };

  const setWallet = (w: string): void => {
    setWalletState(w);
    saveToBrowserStorage("wallet", w);
  };

  const setWalletList = (list: string[]): void => {
    setWalletListState(list);
    saveToBrowserStorage("walletList", list.join(","));
  };

  const setNodeList = (list: WalletNode[]): void => {
    setNodeListState(list);
    saveToBrowserStorage("nodes", JSON.stringify(groupNodeRecords(list)));
    // A slot may name a node that is no longer in the list. Clear it, so a
    // removed node does not stay remembered as the choice for its family.
    setSelectedNodeUrlsState((prev) => {
      const next: NodeSelection = { ...prev };
      for (const family of ["mainnet", "defi-testnet"] as NodeNetwork[]) {
        if (next[family] && !list.some((n) => n.url === next[family])) {
          next[family] = "";
        }
      }
      saveToBrowserStorage("selectedNodeUrls", JSON.stringify(next));
      return next;
    });
  };

  const setNameList = (list: string[]): void => {
    setNameListState(list);
    saveToBrowserStorage("nameList", JSON.stringify(list));
  };

  const setSelectedWalletIndex = (idx: number): void => {
    setSelectedWalletIndexState(idx);
    setSessionAccountIndex(idx);
    saveToBrowserStorage("selectedWalletIndex", idx.toString());
  };

  const setSelectedNodeUrl = useCallback(
    (url: string, network?: NodeNetwork): void => {
      // A newly added node is not in this render's nodeList yet.
      const family = network ?? familyOfUrl(nodeList, url);
      setSelectedNodeUrlsState((prev) => {
        const next = { ...prev, [family]: url };
        saveToBrowserStorage("selectedNodeUrls", JSON.stringify(next));
        return next;
      });
      setActiveNetworkKeyState(family);
      saveToBrowserStorage("activeNetwork", family);
    },
    [saveToBrowserStorage, nodeList],
  );

  /**
   * Move the wallet to the other family's node.
   *
   * Each family keeps its own node, so a round trip returns to the one that
   * was in use before. Nothing happens when the other family has no node.
   */
  const switchNetwork = useCallback((): void => {
    const target = otherNetwork(activeNetworkKey);
    const node = nodeForFamily(nodeList, target, selectedNodeUrls);
    setSelectedNodeUrlsState((prev) => {
      const next = { ...prev, [target]: node?.url ?? "" };
      saveToBrowserStorage("selectedNodeUrls", JSON.stringify(next));
      return next;
    });
    // The family changes either way. A family with no node is still a
    // family the user asked for, and the card says which family is
    // missing a node so the choice can be undone or a node added.
    setActiveNetworkKeyState(target);
    saveToBrowserStorage("activeNetwork", target);
  }, [activeNetworkKey, nodeList, selectedNodeUrls, saveToBrowserStorage]);

  /**
   * Move to a family, using the node remembered for it.
   *
   * This is what the node picker's tabs do: picking the DeFi testnet tab
   * moves the wallet to the DeFi testnet.
   */
  const setActiveNetwork = useCallback(
    (family: NodeNetwork): void => {
      const node = nodeForFamily(nodeList, family, selectedNodeUrls);
      setSelectedNodeUrlsState((prev) => {
        const next = { ...prev, [family]: node?.url ?? "" };
        saveToBrowserStorage("selectedNodeUrls", JSON.stringify(next));
        return next;
      });
      // The family changes either way. A family with no node is still a
      // family the user asked for, and the card says which family is
      // missing a node.
      setActiveNetworkKeyState(family);
      saveToBrowserStorage("activeNetwork", family);
    },
    [nodeList, selectedNodeUrls, saveToBrowserStorage],
  );

  const setPassword = (pwd: string): void => {
    setPasswordState(pwd);
  };

  const setName = (n: string): void => {
    const previous = name;
    setNameState(n);
    saveToBrowserStorage("name", n);
    if (!ledgerAccount) return;
    const from = (previous || "").trim();
    const to = n.trim();
    if (!from || !to || from === to) return;
    void renameLedgerBookmark(from, to).catch((err) => {
      console.warn("[warthog] ledger rename failed", err);
      setNameState(from);
      saveToBrowserStorage("name", from);
    });
  };

  const setVisibleWalletList = (list: boolean[]): void => {
    setVisibleWalletListState(list);
    saveToBrowserStorage("visibleWalletList", list.join(","));
  };

  const setInputWordsBackup = (words: string[]): void => {
    setInputWordsBackupState(words);
  };

  /** Apply key material into session + storage (used by create / import / login). */
  const activateKeyMaterial = async (
    data: WalletKeyMaterial,
    opts?: { password?: string; name?: string; savedWalletName?: string | null },
  ): Promise<void> => {
    const accountName = opts?.name || "Account 0";
    // Scope public account preferences to the seed's first address, never to
    // the currently selected derived account or to a user-editable name.
    let restoredPath = data.pathType || pathType;
    if (data.mnemonic) {
      const otherPath = restoredPath === "hardened" ? "non-hardened" : "hardened";
      if (deriveAccountAtIndex(data.mnemonic, otherPath, 0).address === data.address) restoredPath = otherPath;
    }
    const rootAddress = data.mnemonic ? deriveAccountAtIndex(data.mnemonic, restoredPath, 0).address : data.address;
    const preferencesKey = accountPreferencesKey(rootAddress);
    const stored = await browser.storage.local.get(preferencesKey);
    let preferences = stored[preferencesKey] as AccountPreferences | undefined;
    // Migrate the old global list only if every address belongs to this seed.
    if (!preferences && data.mnemonic && walletList.length && walletList.every((address, i) =>
      deriveAccountAtIndex(data.mnemonic!, restoredPath, i).address === address)) {
      preferences = { addresses: walletList, names: nameList, visible: visibleWalletList, selected: selectedWalletIndex, pathType: restoredPath };
    }
    const valid = preferences && preferences.pathType === restoredPath &&
      Array.isArray(preferences.addresses) && preferences.addresses.length > 0 && preferences.addresses.length <= 1000 &&
      Array.isArray(preferences.names) && Array.isArray(preferences.visible) &&
      preferences.addresses.every((address, i) => data.mnemonic
        ? deriveAccountAtIndex(data.mnemonic!, restoredPath, i).address === address : i === 0 && address === data.address);
    const addresses = valid ? preferences!.addresses : [rootAddress];
    const names = addresses.map((_, i) => valid && typeof preferences!.names[i] === "string" ? preferences!.names[i] : i === 0 ? accountName : `Account ${i}`);
    const visible = addresses.map((_, i) => valid ? preferences!.visible[i] !== false : true);
    const selected = valid && Number.isInteger(preferences!.selected) && preferences!.selected >= 0 && preferences!.selected < addresses.length ? preferences!.selected : 0;
    const activeData = data.mnemonic ? deriveAccountAtIndex(data.mnemonic, restoredPath, selected) : data;
    const sessionToken = newSessionToken();
    const expirationTime = Date.now() + 3600 * 1000;

    await unlockSigningWorker({
      privateKey: activeData.privateKey,
      publicKey: activeData.publicKey,
      address: activeData.address,
      mnemonic: data.mnemonic,
    });
    setLedgerAccount(null);
    void clearLedgerSession();
    setPrivateKeyState(null);
    setSeedPhraseState(null);
    setSigningUnlocked(true);
    setHasMnemonic(Boolean(data.mnemonic));
    accountRootRef.current = rootAddress;
    setWalletState(activeData.address);
    setWalletListState(addresses);
    setNameListState(names);
    setVisibleWalletListState(visible);
    setSelectedWalletIndexState(selected);
    setSessionAccountIndex(selected);
    setNameState(names[selected]);
    setSavedWalletName(opts?.savedWalletName || null);
    setPathTypeState(restoredPath);
    setPasswordState(opts?.password || null);
    if (sessionToken) {
      setTokenState(sessionToken);
    }

    // Persist public session only. Seed / private key / password stay in memory
    // until lock — they are not wrapped with a bundled storage key.
    await Promise.all([
      saveToBrowserStorage("wallet", activeData.address),
      saveToBrowserStorage("walletList", addresses.join(",")),
      saveToBrowserStorage("nameList", JSON.stringify(names)),
      saveToBrowserStorage("visibleWalletList", visible.join(",")),
      saveToBrowserStorage("selectedWalletIndex", String(selected)),
      saveToBrowserStorage("name", names[selected]),
      saveToBrowserStorage("pathType", restoredPath),
      sessionToken
        ? saveToBrowserStorage("token", sessionToken)
        : Promise.resolve(),
      sessionToken
        ? saveToBrowserStorage("tokenExpiration", expirationTime.toString())
        : Promise.resolve(),
    ]);
  };

  const newWallet = async (
    wordCount: WordCount = 12,
    pt: PathType = "hardened",
  ): Promise<void> => {
    try {
      console.log("-------------- newWallet --------------");
      const data = await generateWallet(wordCount, pt);
      accountRootRef.current = data.address;
      await unlockSigningWorker({
        privateKey: data.privateKey,
        publicKey: data.publicKey,
        address: data.address,
        mnemonic: data.mnemonic,
      });
      setSavedWalletName(null);
      setPasswordState(null);
      setSigningUnlocked(true);
      setHasMnemonic(Boolean(data.mnemonic));
      // Seed stays in React only while the recovery screens are showing it.
      setSeedPhrase(data.mnemonic || null);
      setPrivateKey(null);
      setWallet(data.address);
      setWalletList([data.address]);
      setNameList(["Account 0"]);
      setVisibleWalletList([true]);
      setSelectedWalletIndex(0);
      setName("Account 0");
      setPathType(pt);
      if (!nodeList.length) ensureDefaultNodes();
    } catch (error) {
      console.log("Error creating new wallet:", error);
      throw error;
    }
  };

  const addAccount = async (accountName: string | null): Promise<void> => {
    try {
      const status = await getSigningStatus();
      if (!status.hasMnemonic) {
        throw new Error("Cannot add accounts to a private-key-only wallet");
      }
      const index = walletList.length;
      const data = await activateWorkerAccount(pathType, index);
      setPrivateKeyState(null);
      setSigningUnlocked(true);
      setHasMnemonic(true);
      setWallet(data.address);
      setWalletList([...walletList, data.address]);
      setNameList([...nameList, accountName || `Account ${index}`]);
      setVisibleWalletList([...visibleWalletList, true]);
      setSelectedWalletIndex(index);
      setName(accountName || `Account ${index}`);
    } catch (error) {
      console.log("Error adding new account:", error);
      throw error;
    }
  };

  const switchActiveAccount = async (index: number): Promise<void> => {
    if (index === selectedWalletIndex) return;
    if (!Number.isInteger(index) || index < 0 || index >= walletList.length) throw new Error("Invalid account index");
    const status = await getSigningStatus();
    if (!status.hasMnemonic) {
      throw new Error("Cannot switch accounts on a private-key-only wallet");
    }
    const data = await activateWorkerAccount(pathType, index);
    setPrivateKeyState(null);
    setSigningUnlocked(true);
    setHasMnemonic(true);
    setWallet(data.address);
    setSelectedWalletIndex(index);
    setName(nameList[index] || `Account ${index}`);
  };

    const importWallet = async (
    mnemonic: string,
    pt: PathType = "hardened",
    wordCount?: WordCount,
  ): Promise<void> => {
    const words = mnemonic.trim().split(/\s+/).filter(Boolean);
    const wc = (wordCount ||
      (words.length === 24 ? 24 : 12)) as WordCount;
    const data = deriveWallet(words.join(" "), wc, pt, 0);
    accountRootRef.current = data.address;
    await unlockSigningWorker({
      privateKey: data.privateKey,
      publicKey: data.publicKey,
      address: data.address,
      mnemonic: data.mnemonic,
    });
    setSavedWalletName(null);
    setPasswordState(null);
    setSigningUnlocked(true);
    setHasMnemonic(true);
    setSeedPhrase(data.mnemonic || null);
    setPrivateKey(null);
    setWallet(data.address);
    setWalletList([data.address]);
    setNameList(["Account 0"]);
    setVisibleWalletList([true]);
    setSelectedWalletIndex(0);
    setName("Account 0");
    setPathType(pt);
    if (!nodeList.length) ensureDefaultNodes();
  };
  const setToken = (token: string): void => {
    setTokenState(token);
    saveToBrowserStorage("token", token);
    refreshTokenExpiration();
  };

  const refreshTokenExpiration = (): void => {
    const expirationTime = Date.now() + 3600 * 1000;
    saveToBrowserStorage("tokenExpiration", expirationTime.toString());
  };

  const clearToken = (): void => {
    setTokenState(null);
    browser.storage.local
      .remove(["token", "tokenExpiration"])
      .catch((error: unknown) => {
        console.error("Error removing token and token expiration:", error);
      });
  };

  const SECRET_STORAGE_KEYS = [
    "privateKey",
    "seedPhrase",
    "password",
    "inputWordsBackup",
    "token",
    "tokenExpiration",
  ] as const;

  const lockSession = async (): Promise<void> => {
    setSavedWalletName(null);
    toolbarUnlockRef.current = null;
    setSessionAccountIndex(0);
    setSeedPhraseState(null);
    setPrivateKeyState(null);
    setPasswordState(null);
    setTokenState(null);
    setInputWordsBackupState([]);
    setSigningUnlocked(false);
    setLedgerAccount(null);
    void clearLedgerSession();
    setHasMnemonic(false);
    try {
      await lockSigningWorker();
    } catch {
      /* ignore */
    }
    try {
      await browser.storage.local.remove([...SECRET_STORAGE_KEYS]);
    } catch (error: unknown) {
      console.error("Error wiping session secrets:", error);
    }
  };

  const loginWithLedger = async (
    nextPath: PathType = "hardened",
    accountName = "Ledger",
    accountIndex = 0,
    expectedAddress?: string,
  ): Promise<void> => {
    const index =
      Number.isFinite(accountIndex) && accountIndex >= 0
        ? Math.floor(accountIndex)
        : 0;
    const session = await connectLedgerAccount(nextPath, index);
    const sessionToken = newSessionToken("ledger");
    const expirationTime = Date.now() + 3600 * 1000;
    const name = accountName.trim() || "Ledger";
    if (
      expectedAddress &&
      session.address.toLowerCase() !== expectedAddress.toLowerCase()
    ) {
      throw new Error("This Nano account does not match the saved wallet.");
    }
    await saveLedgerBookmark({
      name,
      address: session.address,
      publicKey: session.publicKey,
      pathType: session.pathType,
      index: session.index,
    });
    try {
      await lockSigningWorker();
    } catch {
      /* a hardware session has no key in the worker */
    }
    setSavedWalletName(null);
    setSeedPhraseState(null);
    setPrivateKeyState(null);
    setHasMnemonic(false);
    setPasswordState(null);
    setSessionAccountIndex(0);
    setLedgerAccount(session);
    await saveLedgerSession(session);
    setSigningUnlocked(true);
    setWalletState(session.address);
    setWalletListState([session.address]);
    setNameListState([name]);
    setVisibleWalletListState([true]);
    setSelectedWalletIndexState(0);
    setNameState(name);
    setPathTypeState(nextPath);
    setTokenState(sessionToken);
    if (!nodeList.length) ensureDefaultNodes();
    await Promise.all([
      saveToBrowserStorage("wallet", session.address),
      saveToBrowserStorage("walletList", session.address),
      saveToBrowserStorage("nameList", JSON.stringify([name])),
      saveToBrowserStorage("visibleWalletList", "true"),
      saveToBrowserStorage("selectedWalletIndex", "0"),
      saveToBrowserStorage("name", name),
      saveToBrowserStorage("pathType", nextPath),
      saveToBrowserStorage("token", sessionToken),
      saveToBrowserStorage("tokenExpiration", expirationTime.toString()),
    ]);
  };

  const importPrivateKey = async (privateKeyHex: string): Promise<void> => {
    const data = importFromPrivateKey(privateKeyHex);
    accountRootRef.current = data.address;
    await unlockSigningWorker({
      privateKey: data.privateKey,
      publicKey: data.publicKey,
      address: data.address,
    });
    setSavedWalletName(null);
    setPasswordState(null);
    setSigningUnlocked(true);
    setLedgerAccount(null);
    void clearLedgerSession();
    setHasMnemonic(false);
    setSeedPhrase(null);
    setPrivateKey(null);
    setWallet(data.address);
    setWalletList([data.address]);
    setNameList(["Account 0"]);
    setVisibleWalletList([true]);
    setSelectedWalletIndex(0);
    setName("Account 0");
    if (!nodeList.length) ensureDefaultNodes();
  };

  const currentWalletPayload = async (): Promise<EncryptedWalletPayload> => {
    const exported = await exportWalletFromWorker();
    if (!exported?.privateKey) {
      throw new Error("No active wallet to save");
    }
    return {
      privateKey: exported.privateKey,
      publicKey: exported.publicKey || "",
      address: exported.address || wallet || "",
      mnemonic: exported.mnemonic || seedPhrase || undefined,
      pathType,
    };
  };

  const loginFromEncrypted = async (
    encrypted: string,
    pwd: string,
    walletName?: string | null,
  ): Promise<void> => {
    const info = inspectWalletBlob(encrypted);
    if (info.require2fa) {
      throw new Error(
        "This wallet requires password + passkey. Use Unlock with password + passkey.",
      );
    }
    if (!info.hasPassword) {
      throw new Error(
        "This wallet has no password unlock — use passkey instead",
      );
    }
    const decrypted = await decryptWallet(encrypted, pwd);
    const material: WalletKeyMaterial = {
      privateKey: decrypted.privateKey,
      publicKey: decrypted.publicKey,
      address: decrypted.address,
      mnemonic: decrypted.mnemonic,
      pathType: decrypted.pathType,
    };
    await activateKeyMaterial(material, {
      password: pwd,
      name: walletName || "Account 0",
      savedWalletName: walletName,
    });
  };

  const loginFromPasskey = async (
    encrypted: string,
    walletName?: string | null,
    pwd?: string | null,
  ): Promise<void> => {
    if (isToolbarActionPopup()) {
      await handOffPasskeyJob({
        kind: "unlock",
        name: walletName || "Account 0",
        password: pwd || null,
        encrypted,
      });
    }
    if (!isWebAuthnAvailable()) {
      throw new Error(
        "Passkey unlock needs a modern browser with WebAuthn support",
      );
    }
    const info = inspectWalletBlob(encrypted);
    if (!info.hasPasskey || !info.envelope?.passkey) {
      throw new Error(
        "This wallet has no passkey unlock — use password, or enable passkey after unlock",
      );
    }

    let decrypted: EncryptedWalletPayload;
    if (info.require2fa) {
      if (!pwd) {
        throw new Error(
          "2FA wallet: enter password, then confirm with passkey",
        );
      }
      decrypted = (await unlockEnvelopeWith2fa(
        info.envelope,
        pwd,
        decryptWallet,
      )) as EncryptedWalletPayload;
    } else {
      decrypted = (await decryptWithPasskey(
        info.envelope.passkey,
      )) as EncryptedWalletPayload;
    }

    const material: WalletKeyMaterial = {
      privateKey: decrypted.privateKey,
      publicKey: decrypted.publicKey,
      address: decrypted.address,
      mnemonic: decrypted.mnemonic,
      pathType: decrypted.pathType,
    };
    await activateKeyMaterial(material, {
      password: pwd || undefined,
      name: walletName || "Account 0",
      savedWalletName: walletName,
    });
    toolbarUnlockRef.current = {
      privateKey: decrypted.privateKey,
      publicKey: decrypted.publicKey,
      address: decrypted.address,
      mnemonic: decrypted.mnemonic,
      pathType: decrypted.pathType,
      password: pwd || null,
      name: walletName || "Account 0",
      savedWalletName: walletName,
    };
  };

  const saveCurrentAsNamedWallet = async (
    walletName: string,
    pwd?: string | null,
    opts?: {
      withPasskey?: boolean;
      require2fa?: boolean;
      preferFingerprint?: boolean;
    },
  ): Promise<void> => {
    const payload = await currentWalletPayload();
    const trimmed = walletName.trim();
    if (!trimmed) throw new Error("Wallet name is required");

    const withPasskey = Boolean(opts?.withPasskey);
    const require2fa = Boolean(opts?.require2fa);
    const preferFingerprint = Boolean(opts?.preferFingerprint);

    if (withPasskey && isToolbarActionPopup()) {
      await handOffPasskeyJob({
        kind: "save",
        name: trimmed,
        password: pwd || null,
        require2fa,
        preferFingerprint,
        payload,
      });
    }

    if (!pwd && !withPasskey) {
      throw new Error("Password or passkey required to save");
    }
    if (require2fa && (!pwd || !withPasskey)) {
      throw new Error("2FA needs both a password and passkey");
    }

    const existing = await loadNamedWalletEncrypted(trimmed);
    const prevEnv = existing ? tryParseEnvelope(existing) : null;

    let passwordCipher: string | null = pwd ? await encryptWallet(payload, pwd) : null;
    if (!passwordCipher && prevEnv?.password) passwordCipher = prevEnv.password;
    if (!passwordCipher && existing && !prevEnv) passwordCipher = existing;

    if (withPasskey) {
      if (!isWebAuthnAvailable()) {
        throw new Error("Passkey unlock needs HTTPS and a modern browser");
      }
      // passkeyWallet is a JS port; cast opts to avoid loose default-param inference
      const { envelope } = (await buildEnvelopeWithPasskey(payload, {
        displayName: trimmed,
        existingPasswordCipher: passwordCipher,
        previousEnvelope: prevEnv,
        require2fa: require2fa && Boolean(passwordCipher || pwd),
        preferFingerprint,
      } as Record<string, unknown>)) as {
        envelope: {
          password: string | null;
          require2fa: boolean;
          [k: string]: unknown;
        };
      };
      if (require2fa && pwd) {
        envelope.password = await encryptWallet(payload, pwd);
        envelope.require2fa = true;
      }
      await saveNamedWallet(trimmed, serializeEnvelope(envelope));
      setSavedWalletName(trimmed);
      return;
    }

    if (pwd) {
      const cipher = await encryptWallet(payload, pwd);
      if (prevEnv?.passkey) {
        const next = envelopeWithPassword(payload, cipher, prevEnv, {
          require2fa,
        });
        await saveNamedWallet(trimmed, serializeEnvelope(next));
      } else {
        await saveNamedWallet(trimmed, cipher);
      }
      setSavedWalletName(trimmed);
    }
  };

  const resumePasskeyHandoff = async (): Promise<void> => {
    const job = await readPasskeyJob();
    if (!job) {
      throw new Error(
        "This passkey window expired. Close it and try again from the toolbar icon.",
      );
    }
    if (job.kind === "unlock") {
      await loginFromPasskey(job.encrypted, job.name, job.password);
      await clearPasskeyJob();
      return;
    }

    const payload = job.payload;
    const trimmed = job.name.trim();
    const pwd = job.password;
    const require2fa = job.require2fa;
    if (!trimmed) throw new Error("Wallet name is required");
    if (!isWebAuthnAvailable()) {
      throw new Error("Passkey unlock needs a modern browser");
    }

    const existing = await loadNamedWalletEncrypted(trimmed);
    const prevEnv = existing ? tryParseEnvelope(existing) : null;
    let passwordCipher: string | null = pwd ? await encryptWallet(payload, pwd) : null;
    if (!passwordCipher && prevEnv?.password) passwordCipher = prevEnv.password;
    if (!passwordCipher && existing && !prevEnv) passwordCipher = existing;

    const { envelope } = (await buildEnvelopeWithPasskey(payload, {
      displayName: trimmed,
      existingPasswordCipher: passwordCipher,
      previousEnvelope: prevEnv,
      require2fa: require2fa && Boolean(passwordCipher || pwd),
      preferFingerprint: job.preferFingerprint,
    } as Record<string, unknown>)) as {
      envelope: {
        password: string | null;
        require2fa: boolean;
        [k: string]: unknown;
      };
    };
    if (require2fa && pwd) {
      envelope.password = await encryptWallet(payload, pwd);
      envelope.require2fa = true;
    }
    await saveNamedWallet(trimmed, serializeEnvelope(envelope));
    await activateKeyMaterial(
      {
        privateKey: payload.privateKey,
        publicKey: payload.publicKey,
        address: payload.address,
        mnemonic: payload.mnemonic,
        pathType: payload.pathType,
      },
      { password: pwd || undefined, name: trimmed, savedWalletName: trimmed },
    );
    toolbarUnlockRef.current = {
      privateKey: payload.privateKey,
      publicKey: payload.publicKey,
      address: payload.address,
      mnemonic: payload.mnemonic,
      pathType: payload.pathType,
      password: pwd,
      name: trimmed,
      savedWalletName: trimmed,
    };
    await clearPasskeyJob();
  };

  const finishPasskeyInToolbar = async (): Promise<boolean> => {
    const data = toolbarUnlockRef.current;
    if (!data?.privateKey || !data.address) return false;
    try {
      await storeToolbarUnlock(data);
      const current = await browser.windows.getCurrent();
      await askBackgroundToReopenToolbar(current?.id);
      return true;
    } catch (err) {
      console.warn("[warthog] could not return to the toolbar", err);
      await clearToolbarUnlock();
      return false;
    }
  };

  const enablePasskeyOnCurrentWallet = async (opts?: {
    password?: string | null;
    require2fa?: boolean;
    preferFingerprint?: boolean;
    name?: string | null;
  }): Promise<boolean> => {
    if (!signingUnlocked || !wallet) {
      throw new Error("Unlock your wallet first, then enable passkey");
    }
    const tag =
      String(opts?.name || savedWalletName || name || "").trim() || "Main";
    await saveCurrentAsNamedWallet(tag, opts?.password ?? password, {
      withPasskey: true,
      require2fa: Boolean(opts?.require2fa),
      preferFingerprint: Boolean(opts?.preferFingerprint),
    });
    if (!name) setName(tag);
    return true;
  };

  const clearWalletData = (): void => {
    setSavedWalletName(null);
    setSeedPhraseState(null);
    setPrivateKeyState(null);
    setLedgerAccount(null);
    void clearLedgerSession();
    setWalletState(null);
    setPasswordState(null);
    setNameState(null);
    browser.storage.local
      .remove([
        "seedPhrase",
        "privateKey",
        "wallet",
        "password",
        "name",
        "pathType",
        "walletList",
        "nameList",
        "visibleWalletList",
      ])
      .then(() => {
        console.log("Wallet data removed");
      })
      .catch((error: unknown) => {
        console.error("Error removing wallet data:", error);
      });
  };

  const activateRef = useRef(activateKeyMaterial);
  activateRef.current = activateKeyMaterial;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (/passkey-host/.test(location.hash || "")) return;
        const pending = await readToolbarUnlock();
        if (!alive) return;
        if (pending) {
          await activateRef.current(
            {
              privateKey: pending.privateKey,
              publicKey: pending.publicKey,
              address: pending.address,
              mnemonic: pending.mnemonic,
              pathType: pending.pathType,
            },
            { password: pending.password || undefined, name: pending.name, savedWalletName: pending.savedWalletName },
          );
          await clearToolbarUnlock();
          return;
        }
        const hardware = await readLedgerSession();
        if (!alive || !hardware) return;
        // The toolbar dropdown logs a Ledger session out when it closes.
        // A one-shot arm lets the popup opened right after connect stay in.
        // A handoff flag means a connect or sign tab still needs the session.
        if (isLedgerToolbarPopup()) {
          const armed = await consumeLedgerPopupArm();
          if (!armed) {
            const handingOff = await ledgerHandoffPending();
            if (!handingOff) {
              const named = await browser.storage.local.get(["token", "name"]);
              const namedToken = await decryptValue(
                typeof named.token === "string" ? named.token : undefined,
              );
              const namedLabel = await decryptValue(
                typeof named.name === "string" ? named.name : undefined,
              );
              if (namedToken?.startsWith("ledger-")) {
                await rememberLedgerBookmark({
                  name: namedLabel?.trim() || "Ledger",
                  address: hardware.address,
                  publicKey: hardware.publicKey,
                  pathType: hardware.pathType,
                  index: hardware.index,
                });
                await browser.storage.local.remove(["token", "tokenExpiration"]);
              }
              await clearLedgerSession();
            }
            return;
          }
        }
        // token and tokenExpiration are encrypted at rest. Reading the raw
        // hex never starts with "ledger-", so the dropdown stayed logged out.
        const stored = await browser.storage.local.get(["token", "tokenExpiration", "name"]);
        const storedToken = await decryptValue(
          typeof stored.token === "string" ? stored.token : undefined,
        );
        const expText = await decryptValue(
          typeof stored.tokenExpiration === "string" ? stored.tokenExpiration : undefined,
        );
        const exp = parseInt(expText || "0", 10);
        if (!storedToken?.startsWith("ledger-") || !Number.isFinite(exp) || Date.now() >= exp) {
          return;
        }
        const storedName = await decryptValue(
          typeof stored.name === "string" ? stored.name : undefined,
        );
        if (!alive) return;
        setLedgerAccount(hardware);
        setSigningUnlocked(true);
        setHasMnemonic(false);
        setTokenState((current) => current || storedToken);
        setWalletState((current) => current || hardware.address);
        setPathTypeState(hardware.pathType);
        setNameState((current) => current || storedName || "Ledger");
        setWalletListState((current) => (current.length ? current : [hardware.address]));
        setNameListState((current) => (current.length ? current : [storedName || "Ledger"]));
      } catch (err) {
        console.warn("[warthog] toolbar unlock failed", err);
      } finally {
        if (alive) setSessionReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Drop any leftover secrets from older builds that wrapped keys with a
    // bundled storage password. Named warthogWallet_* envelopes are untouched.
    void browser.storage.local.remove([
      "privateKey",
      "seedPhrase",
      "password",
      "inputWordsBackup",
    ]);
    loadFromChromeStorage("wallet", (value) => {
      if (value) setWalletState((current) => current || value);
    });
    loadFromChromeStorage("pathType", (pt) => {
      if (pt === "hardened" || pt === "non-hardened") {
        setPathTypeState(pt);
      }
    });
    loadFromChromeStorage("walletList", (list) => {
      const next = list ? list.split(",").filter(Boolean) : [];
      setWalletListState((current) => (current.length ? current : next));
    });
    loadFromChromeStorage("nameList", (list) =>
      setNameListState(parseStringList(list)),
    );
    Promise.all([
      new Promise<string | null>((resolve) =>
        loadFromChromeStorage("nodes", resolve),
      ),
      new Promise<string | null>((resolve) =>
        loadFromChromeStorage("selectedNodeUrls", resolve),
      ),
      new Promise<string | null>((resolve) =>
        loadFromChromeStorage("selectedNodeUrl", resolve),
      ),
      new Promise<string | null>((resolve) => loadFromChromeStorage("activeNetwork", resolve)),
    ]).then(([storedNodes, storedSelection, legacySelection, storedFamily]) => {
      // The nodes are stored as JSON, with the two families apart. There is
      // no older format to read: a wallet without the key starts from the
      // presets.
      const groups: NodeGroups = storedNodes
        ? (JSON.parse(storedNodes) as NodeGroups)
        : groupNodeRecords(defaultNodes);
      const nodes = flattenNodeGroups(groups);
      setNodeListState(nodes);
      saveToBrowserStorage("nodes", JSON.stringify(groups));

      // Each family keeps its own node. An install that predates the pair
      // has one URL, which belongs to the family it is in; the other family
      // takes the first node of that family.
      //
      // A stored pair is authoritative for every family it names, including
      // one it leaves empty. An empty slot means the user cleared it, and
      // seeding it again would undo that on every reload. A family the
      // stored pair does not mention at all is seeded, which is the fresh
      // install and the malformed pair.
      const seeded = defaultSelection(nodes);
      let selection: NodeSelection = seeded;
      if (storedSelection) {
        try {
          const parsed = JSON.parse(storedSelection) as Partial<NodeSelection>;
          const hasMainnet = typeof parsed.mainnet === "string";
          const hasDefi = typeof parsed["defi-testnet"] === "string";
          if (hasMainnet || hasDefi) {
            selection = {
              mainnet: hasMainnet ? parsed.mainnet! : seeded.mainnet,
              "defi-testnet": hasDefi
                ? parsed["defi-testnet"]!
                : seeded["defi-testnet"],
            };
          }
        } catch {
          // A malformed pair falls back to the defaults.
        }
      } else if (legacySelection) {
        const found = nodes.find((n) => n.url === legacySelection);
        if (found) selection[found.network] = found.url;
      }

      // The remembered URL may name a node that is no longer in the list.
      // Such a slot is cleared rather than pointed at another node.
      const mainnetNode = nodeForFamily(nodes, "mainnet", selection);
      const defiNode = nodeForFamily(nodes, "defi-testnet", selection);
      const settled: NodeSelection = {
        mainnet:
          selection.mainnet && !mainnetNode ? "" : selection.mainnet,
        "defi-testnet":
          selection["defi-testnet"] && !defiNode
            ? ""
            : selection["defi-testnet"],
      };
      setSelectedNodeUrlsState(settled);
      saveToBrowserStorage("selectedNodeUrls", JSON.stringify(settled));

      // The wallet opens on the family the remembered node belongs to. A fresh
      // install opens on mainnet, which is the chain a plain WART transfer
      // works on.
      const legacy = nodes.find((n) => n.url === legacySelection);
      const family: NodeNetwork = storedFamily === "mainnet" || storedFamily === "defi-testnet" ? storedFamily : legacy?.network ?? "mainnet";
      if (storedFamily === "mainnet" || storedFamily === "defi-testnet") {
        setActiveNetworkKeyState(storedFamily);
        return;
      }
      const active = family === "mainnet" ? mainnetNode : defiNode;
      if (active) {
        setActiveNetworkKeyState(active.network);
      } else {
        const fallback = nodes[DEFAULT_NODE_INDEX] ?? nodes[0];
        if (fallback) setActiveNetworkKeyState(fallback.network);
      }
    });
    // The node list used to be two comma-joined strings and an index. The
    // nodes are JSON now, and the old keys are dropped rather than read.
    browser.storage.local.remove([
      "nodeList",
      "nodeNameList",
      "selectedNodeIndex",
      "selectedNodeUrl",
    ]);
    loadFromChromeStorage("visibleWalletList", (visible) => {
      const boolArray = visible
        ? visible.split(",").map((val) => val === "true")
        : [];
      setVisibleWalletListState(boolArray);
    });
    loadFromChromeStorage("selectedWalletIndex", (idx) => {
      const index = idx ? parseInt(idx, 10) : 0;
      const safe = Number.isSafeInteger(index) && index >= 0 ? index : 0;
      setSelectedWalletIndexState(safe);
      setSessionAccountIndex(safe);
    });
    loadFromChromeStorage("name", (value) => {
      if (value) setNameState((current) => current || value);
    });
    loadFromChromeStorage("token", (value) => {
      // Replace a token that still has the password baked into it.
      if (value && !value.startsWith("ledger-") && !isOpaqueSessionToken(value)) {
        const next = newSessionToken();
        setTokenState((current) => current || next);
        void saveToBrowserStorage("token", next);
        setTokenLoaded(true);
        return;
      }
      if (value) setTokenState((current) => current || value);
      setTokenLoaded(true);
    });
  }, [loadFromChromeStorage, saveToBrowserStorage]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadFromChromeStorage("tokenExpiration", (expiration) => {
        const expirationTime = expiration ? parseInt(expiration, 10) : 0;
        if (Date.now() >= expirationTime) {
          clearToken();
        }
      });
    }, 1000 * 60);
    return () => clearInterval(interval);
  }, [loadFromChromeStorage]);

  // Which family the wallet is on.
  //
  // The family is a field on the node record, so nothing has to guess it
  // from the URL. The slot for that family names the node.
  const activeNetwork: NodeNetwork = activeNetworkKey;

  // The active family has no node, so the wallet has nothing to talk to.
  // Derived, so it cannot go stale when a node is added, removed or picked.
  const nodeError = useMemo(() => {
    const node = nodeForFamily(nodeList, activeNetwork, selectedNodeUrls);
    if (node) return null;
    return `No ${familyLabel(activeNetwork)} node selected.`;
  }, [nodeList, activeNetwork, selectedNodeUrls]);

  // The active node is the one the active family's slot points at. The slot
  // holds a URL, and the URL is looked up in the list, so the index stays
  // right when the list is regrouped, reordered, or gains a node.
  const selectedNodeIndex = useMemo(() => {
    // The remembered node, or the family's first node when the remembered
    // one is gone. When the family has no node at all the index is -1:
    // falling back to the list's first entry would be wrong, because that
    // can be a node of the other family.
    const node = nodeForFamily(nodeList, activeNetwork, selectedNodeUrls);
    if (!node) return -1;
    const found = nodeList.findIndex(
      (n) => normalizeNodeUrl(n.url) === normalizeNodeUrl(node.url),
    );
    return found >= 0 ? found : -1;
  }, [nodeList, selectedNodeUrls, activeNetwork]);

  const lockSessionRef = useRef(lockSession);
  lockSessionRef.current = lockSession;
  const ledgerAccountRef = useRef(ledgerAccount);
  ledgerAccountRef.current = ledgerAccount;

  // Closing the toolbar ends a Ledger session. The host tab and a software
  // password session stay as they are. pagehide can be dropped, so the next
  // popup also refuses to restore unless it was just armed.
  useEffect(() => {
    const onHide = () => {
      if (!isLedgerToolbarPopup()) return;
      if (!ledgerAccountRef.current) return;
      void (async () => {
        if (await consumeLedgerHandoff()) return;
        await lockSessionRef.current();
      })();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // Auto-lock after 15 minutes without pointer or key activity. The handler is
  // registered on the signing bridge so the worker-side timer can call back
  // into the session state.
  useEffect(() => {
    setIdleLockHandler(() => {
      void lockSessionRef.current();
    });
    const bump = () => bumpIdleTimer();
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    bumpIdleTimer();
    return () => {
      setIdleLockHandler(null);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, []);

  // Null when the active family has no node. The wallet does not fall back
  // to a node of the other family, or it would claim to be on a network it
  // is not talking to.
  const selectedNode: WalletNode | null =
    selectedNodeIndex >= 0 ? nodeList[selectedNodeIndex] ?? null : null;
  const selectedNodeUrl: string | null = selectedNode?.url ?? null;
  const selectedNetworkLabel = networkLabel(selectedNode);
  // Password or session token (passkey-only unlock sets token without password)
  const isAuthenticated = Boolean(wallet && signingUnlocked && token);
  const canAddAccounts = hasMnemonic || Boolean(seedPhrase);

  useEffect(() => {
    if (!isAuthenticated || ledgerAccount || !accountRootRef.current || !walletList.length) return;
    const preferences: AccountPreferences = { addresses: walletList, names: nameList, visible: visibleWalletList, selected: selectedWalletIndex, pathType };
    void browser.storage.local.set({ [accountPreferencesKey(accountRootRef.current)]: preferences });
  }, [isAuthenticated, ledgerAccount, walletList, nameList, visibleWalletList, selectedWalletIndex, pathType]);

  return (
    <WalletContext.Provider
      value={{
        seedPhrase,
        privateKey,
        wallet,
        password,
        name,
        savedWalletName,
        pathType,
        token,
        walletList,
        nodeList,
        selectedNode,
        nameList,
        selectedWalletIndex,
        selectedNodeIndex,
        visibleWalletList,
        tmpDestinationWallet,
        tmpAssetHash,
        tmpTokenAmount,
        tmpWartAmount,
        tmpLimitPrice,
        tmpPrecision,
        tmpCancelHeight,
        tmpCancelNonceId,
        tmpTokenName,
        tmpTransferType,
        tmpTradeType,
        tmpLiquidityType,
        inputWordsBackup,
        selectedNodeUrl,
        selectedNodeUrls,
        activeNetwork,
        nodeError,
        selectedNetworkLabel,
        isAuthenticated,
        ledgerAccount,
        loginWithLedger,
        sessionReady,
        tokenLoaded,
        signingUnlocked,
        canAddAccounts,
        accountPath,
        setSeedPhrase,
        setPrivateKey,
        setWallet,
        setPassword,
        setName,
        setWalletList,
        setNodeList,
        setNameList,
        setVisibleWalletList,
        setSelectedWalletIndex,
        setSelectedNodeUrl,
        switchNetwork,
        setActiveNetwork,
        setPathType,
        clearWalletData,
        setToken,
        clearToken,
        lockSession,
        newWallet,
        addAccount,
        switchActiveAccount,
        setWalletListState,
        setNodeListState,
        setNameListState,
        setSelectedWalletIndexState,
        setSelectedNodeUrlsState,
        setVisibleWalletListState,
        setTmpDestinationWalletState,
        setTmpAssetHashState,
        setTmpTokenAmountState,
        setTmpWartAmountState,
        setTmpLimitPriceState,
        setTmpPrecisionState,
        setTmpCancelHeightState,
        setTmpCancelNonceIdState,
        setTmpTokenNameState,
        setTmpTransferTypeState,
        refreshTokenExpiration,
        setTmpTradeTypeState,
        setTmpLiquidityTypeState,
        importWallet,
        importPrivateKey,
        loginFromEncrypted,
        loginFromPasskey,
        resumePasskeyHandoff,
        finishPasskeyInToolbar,
        saveCurrentAsNamedWallet,
        enablePasskeyOnCurrentWallet,
        activateKeyMaterial,
        setInputWordsBackup,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export default WalletContext;
