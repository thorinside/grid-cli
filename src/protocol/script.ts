let gridModule: typeof import("@intechstudio/grid-protocol") | null = null;

async function loadGridModule() {
  if (gridModule) return gridModule;
  const originalLog = console.log;
  try {
    console.log = () => {};
    gridModule = await import("@intechstudio/grid-protocol");
  } finally {
    console.log = originalLog;
  }
  return gridModule;
}

const module = await loadGridModule();

export const GridScript = module.GridScript;
