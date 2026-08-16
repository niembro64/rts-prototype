type ThreeAssetLoader<Result> = {
  load: (
    url: string,
    onLoad: (result: Result) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) => unknown;
};

export function loadThreeAsset<Result>(
  loader: ThreeAssetLoader<Result>,
  url: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}
