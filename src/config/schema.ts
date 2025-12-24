export interface ModuleFile {
  version: string;
  created: string;
  modified: string;
  toolVersion: string;
  index: number;
  position: [number, number];
  type: string;
  typeId: number;
  firmware: {
    major: number;
    minor: number;
    patch: number;
  };
  elements: Array<{
    index: number;
    type: string;
  }>;
  pages?: number[];
}
