import { createContext } from 'react';

/**
 * The assistant answer that a piece of Markdown belongs to. Only Kiro's answers provide it, so a `kiro-mcp` block
 * becomes a card there and stays plain code in Kiro's reasoning and in a spec. The card's buttons name the answer and
 * the server, and the host reads the block again from its own copy of that answer.
 */
export const ItemContext = createContext<{ sessionId: string; itemId: number } | undefined>(undefined);
