import type { H5pPackageDescriptor } from '../../apps/community-api/src/scenePackageTypes';
export interface H5pLocalPackage extends H5pPackageDescriptor {
  lastPlayedAt?: string;
  resumeAvailable?: boolean;
  progressError?: string;
  /** Untrusted package-reported result, not mastery or personal cognition. */
  reportedScore?: { raw: number; max: number };
  reportedCompleted?: boolean;
}
export interface H5pLocalApi {
  list(): Promise<{ packages: H5pLocalPackage[]; errors: string[] }>;
  importPackage(): Promise<{ canceled?: boolean; package?: H5pLocalPackage }>;
  open(id: string): Promise<{ canceled?: boolean }>;
  restart(id: string): Promise<{ canceled?: boolean; backup?: string }>;
}
