/**
 * Money Cycle settings that are still open product decisions. The defaults
 * are the conservative choice for each one.
 */

export interface CycleConfig {
  /** Whether a bill amount can change after payments exist for it. */
  allowAmountEditOnPaidBill: boolean;
  /** Currency conversion between bills. Off: mixed currencies are never added. */
  currencyConversionEnabled: boolean;
  /** Default reminder time, "HH:mm". */
  defaultReminderTime: string;
}

export const DEFAULT_CYCLE_CONFIG: CycleConfig = {
  allowAmountEditOnPaidBill: false, // Default conservative: require undoing payment first
  currencyConversionEnabled: false, // Default strict: currency mixing rejected
  defaultReminderTime: '09:00',
};

let activeCycleConfig: CycleConfig = { ...DEFAULT_CYCLE_CONFIG };

export function getCycleConfig(): CycleConfig {
  return activeCycleConfig;
}

export function setCycleConfig(patch: Partial<CycleConfig>): void {
  activeCycleConfig = { ...activeCycleConfig, ...patch };
}
