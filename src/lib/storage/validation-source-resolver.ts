import "server-only";
import type { Readable } from "stream";
import type { ObjectMetadata, StorageAdapter } from "./storage-adapter";
import { getStorageAdapter } from "./index";
import { prepareGoogleDriveSource } from "../google-drive/google-drive-validation-source";

export type ValidationStorageReader = Pick<
  StorageAdapter,
  "headObject" | "createReadStream"
>;

export interface ValidationSourceAssetInput {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly originalName: string;
  readonly declaredMimeType: string;
  readonly expectedSize: bigint;
  readonly actualSize: bigint | null;
}

export interface PreparedValidationSource {
  readonly metadata: ObjectMetadata;
  readonly createReadStream: () => Promise<Readable>;
}

export interface ValidationSourceResolverDependencies {
  readonly getR2Adapter?: () => ValidationStorageReader;
  readonly prepareGoogleDriveSource?: typeof prepareGoogleDriveSource;
}

export async function prepareValidationSource(
  asset: ValidationSourceAssetInput,
  dependencies?: ValidationSourceResolverDependencies
): Promise<PreparedValidationSource | null> {
  if (asset.provider === "R2") {
    const getAdapter = dependencies?.getR2Adapter || getStorageAdapter;
    const adapter = getAdapter();
    const meta = await adapter.headObject(asset.bucket, asset.objectKey);
    if (!meta) {
      return null;
    }
    return {
      metadata: meta,
      createReadStream: async () => {
        return await adapter.createReadStream(asset.bucket, asset.objectKey);
      },
    };
  }

  if (asset.provider === "GOOGLE_DRIVE") {
    const prepareGD = dependencies?.prepareGoogleDriveSource || prepareGoogleDriveSource;
    return await prepareGD(asset);
  }

  throw new Error("UNSUPPORTED_STORAGE_PROVIDER");
}
