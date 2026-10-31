/** Deployment instance identity is independent of the providers it contains. */
export interface PublicSource {
  readonly instanceId: string;
  readonly label: string;
  readonly publicBasePath: string;
  readonly aliases: readonly string[];
  readonly authScope: string;
  /** Credential types whose new accounts belong on this instance. Absent: none claimed. */
  readonly providers?: readonly string[];
}

export interface DeploymentSource extends PublicSource {
  readonly upstreamOrigin: string;
  readonly managementKeyFile: string;
}

export interface SourceManifest {
  readonly schemaVersion: 1;
  readonly defaultInstanceId: string;
  readonly history: {
    readonly upstreamOrigin: string;
    readonly managementKeyFile: string;
  };
  readonly sources: readonly DeploymentSource[];
  /** Explicit grant: the history management key may read this complete CPA dataset. */
  readonly analytics?: {
    readonly upstreamOrigin: string;
    readonly adminKeyFile: string;
    readonly dataset: 'homelab';
  };
}

export interface SourceDiscovery {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly defaultInstanceId: string;
  readonly sources: readonly PublicSource[];
}

export interface ResolvedSource extends PublicSource {
  readonly apiBase: string;
}

export interface SourceResolution {
  readonly mode: 'deployment' | 'external';
  readonly revision: string;
  readonly selectedInstanceId: string;
  readonly sources: readonly ResolvedSource[];
}
