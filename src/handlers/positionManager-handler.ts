/*
 * PositionManager event handlers (Transfer, Subscription, Unsubscription)
 *
 * Mirrors the v4-subgraph's transfer.ts / subscribe.ts / unsubscribe.ts:
 * Position tracks the current owner per tokenId, while Transfer / Subscribe /
 * Unsubscribe are immutable per-event records.
 */
import { indexer } from "envio";
import { positionDefaults } from "./position-fees";

// Positions are per-chain: PositionManager tokenIds collide across chains
const positionId = (chainId: number, tokenId: bigint) =>
  `${chainId}_${tokenId}`;

const eventId = (event: {
  chainId: number;
  block: { number: number };
  logIndex: number;
}) => `${event.chainId}_${event.block.number}_${event.logIndex}`;

indexer.onEvent(
  { contract: "PositionManager", event: "Transfer" },
  async ({ event, context }) => {
    const id = positionId(event.chainId, event.params.id);

    // Mint (from == zero address) creates the position; later transfers only
    // change ownership.
    //
    // The liquidity and fee columns get their zero defaults here because this
    // handler may run before the matching PoolManager.ModifyLiquidity (event
    // order within a mint tx is not guaranteed). The ModifyLiquidity path fills
    // them in and never reads them back from this row, so whichever runs first
    // is safe. The spread below preserves whatever the other path already wrote.
    // Addresses are stored LOWERCASE, never EIP-55 checksummed. envio's
    // `address_format` defaults to checksum, but the Ponder indexer this
    // replaces wrote lowercase and the Tickwise adapter filters `owner` with an
    // exact string match — a checksummed row simply returns nothing. The
    // ModifyLiquidity path already lowercases; this path did not, which is why
    // 7,202 of 8,967 deployed positions differed from Ponder by case alone.
    const owner = event.params.to.toLowerCase();

    const position = (await context.Position.get(id)) ?? {
      id,
      chainId: BigInt(event.chainId),
      tokenId: event.params.id,
      owner,
      origin: event.transaction.from?.toLowerCase() || "NONE",
      createdAtTimestamp: BigInt(event.block.timestamp),
      ...positionDefaults(),
      createdAtBlockNumber: BigInt(event.block.number),
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTimestamp: BigInt(event.block.timestamp),
    };

    context.Position.set({ ...position, owner });

    context.Transfer.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.id,
      from: event.params.from.toLowerCase(),
      to: owner,
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from?.toLowerCase() || "NONE",
      position_id: id,
    });
  }
);

indexer.onEvent(
  { contract: "PositionManager", event: "Subscription" },
  async ({ event, context }) => {
    context.Subscribe.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.tokenId,
      address: event.params.subscriber.toLowerCase(),
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from?.toLowerCase() || "NONE",
      position_id: positionId(event.chainId, event.params.tokenId),
    });
  }
);

indexer.onEvent(
  { contract: "PositionManager", event: "Unsubscription" },
  async ({ event, context }) => {
    context.Unsubscribe.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.tokenId,
      address: event.params.subscriber.toLowerCase(),
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from?.toLowerCase() || "NONE",
      position_id: positionId(event.chainId, event.params.tokenId),
    });
  }
);
