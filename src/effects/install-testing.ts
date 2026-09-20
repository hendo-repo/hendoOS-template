/**
 * Test-only installer fault surface. Production edges never import this module.
 * It deliberately owns the capability to request process-exiting failpoints.
 */
import {
  __installWithFaults,
  __recoverWithFaults,
  __uninstallWithFaults,
  type Failpoints,
  type InstallOptions,
  type InstallReport,
  type RecoveryOptions,
  type UninstallOptions,
} from './install';

export type FaultedInstallOptions = InstallOptions & { failpoints?: Failpoints };
export type FaultedUninstallOptions = UninstallOptions & { failpoints?: Failpoints };
export type FaultedRecoveryOptions = RecoveryOptions & { failpoints?: Failpoints };

export const install = (options: FaultedInstallOptions): Promise<InstallReport> => __installWithFaults(options);
export const uninstall = (options: FaultedUninstallOptions): Promise<InstallReport> => __uninstallWithFaults(options);
export const recoverInstall = (options: FaultedRecoveryOptions): Promise<InstallReport> => __recoverWithFaults(options);
