/**
 * Budget persistence: use budgetStore (IndexedDB + localStorage).
 */
export { type PersistedBudget, loadBudget, saveBudget, clearBudget, defaultCapAtomic } from "./budgetStore";
