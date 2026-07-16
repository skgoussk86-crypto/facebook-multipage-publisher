import { Readable } from "stream";
import { prepareValidationSource, ValidationSourceAssetInput, PreparedValidationSource } from "../src/lib/storage/validation-source-resolver";
import { prepareGoogleDriveSource, GDValidationSourceDependencies } from "../src/lib/google-drive/google-drive-validation-source";
import { GoogleDriveConnectionRecord } from "../src/lib/google-drive/google-drive-connection-repository";
import { GoogleDriveConfig } from "../src/lib/google-drive/google-drive-config";
import { GoogleDriveFileMetadata } from "../src/lib/google-drive/google-drive-media-client";
import { MediaValidationError } from "../src/lib/storage/media-probe";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const mockConnection: GoogleDriveConnectionRecord = {
  id: "conn-123",
  userId: "user-123",
  encryptedRefreshToken: "enc:refresh-token-abc",
  refreshTokenKeyVersion: "1",
  googleAccountEmail: "account@gmail.com",
  driveFolderId: "folder-456",
  connectedAt: new Date(),
  updatedAt: new Date(),
  revokedAt: null,
};

const mockConfig: GoogleDriveConfig = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  redirectUri: "https://redirect.com",
  encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerUserId: "user-123",
};

const mockMetadata: GoogleDriveFileMetadata = {
  id: "drive-file-123",
  name: "video.mp4",
  mimeType: "video/mp4",
  size: 10485760,
  md5Checksum: "md5-checksum-abc",
  modifiedTime: new Date("2026-07-16T12:00:00Z"),
  parents: ["folder-456"],
  trashed: false,
  appProperties: {
    assetId: "asset-123",
  },
};

const defaultDeps: GDValidationSourceDependencies = {
  getActiveConnection: async (userId: string) => {
    void userId;
    return mockConnection;
  },
  getGoogleDriveConfig: () => mockConfig,
  decryptRefreshToken: (env: string) => env.replace("enc:", ""),
  getAccessToken: async (refreshToken: string) => {
    void refreshToken;
    return "access-token-999";
  },
  getFileMetadata: async (accessToken: string, fileId: string) => {
    void accessToken;
    void fileId;
    return mockMetadata;
  },
  createReadStream: async (accessToken: string, fileId: string) => {
    void accessToken;
    void fileId;
    return new Readable({ read() {} });
  },
};

const validAssetInput: ValidationSourceAssetInput = {
  id: "asset-123",
  userId: "user-123",
  provider: "GOOGLE_DRIVE",
  bucket: "folder-456",
  objectKey: "drive-file-123",
  originalName: "video.mp4",
  declaredMimeType: "video/mp4",
  expectedSize: BigInt(10485760),
  actualSize: BigInt(10485760),
};

const r2AssetInput: ValidationSourceAssetInput = {
  id: "asset-r2",
  userId: "user-123",
  provider: "R2",
  bucket: "bucket-r2",
  objectKey: "uploads/user-123/video.mp4",
  originalName: "video.mp4",
  declaredMimeType: "video/mp4",
  expectedSize: BigInt(10485760),
  actualSize: BigInt(10485760),
};

function assertNoLeak(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const secrets = [
    "enc:refresh-token-abc",
    "refresh-token-abc",
    "access-token-999",
    "drive-file-123",
    "folder-456",
    "account@gmail.com",
    "Google OAuth expired token signature 999",
  ];
  for (const secret of secrets) {
    assert(!msg.includes(secret), `Leak detected! Error contains secret: ${secret}`);
  }
}

function requirePreparedSource(
  source: PreparedValidationSource | null,
  testName: string
): PreparedValidationSource {
  if (source === null) {
    throw new Error(`${testName}: expected a prepared validation source.`);
  }
  return source;
}

async function runTests() {
  console.log("Running Google Drive Video Validation Integration Tests...\n");
  let passedCount = 0;

  // 1. R2 provider invokes only the R2 metadata adapter.
  try {
    let r2HeadCalled = false;
    const mockR2Adapter = () => ({
      headObject: async (bucket: string, key: string) => {
        void bucket;
        void key;
        r2HeadCalled = true;
        return {
          bucket: "bucket-r2",
          objectKey: "key-r2",
          size: 100,
          etag: "etag",
          contentType: "video/mp4",
        };
      },
      createReadStream: async (bucket: string, key: string) => {
        void bucket;
        void key;
        return new Readable({ read() {} });
      },
    });

    let googleSourceCalled = false;
    const mockGoogleSource = async () => {
      googleSourceCalled = true;
      return null;
    };

    const res = await prepareValidationSource(r2AssetInput, {
      getR2Adapter: mockR2Adapter,
      prepareGoogleDriveSource: mockGoogleSource,
    });

    assert(res !== null, "R2 source resolved successfully");
    assert(r2HeadCalled, "R2 adapter headObject must be called");
    assert(!googleSourceCalled, "Google Drive validation source must NOT be called on R2 provider");
    console.log("Test 1 Passed: R2 provider invokes only the R2 metadata adapter [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 1 Failed:", err);
  }

  // 2. R2 source lazily invokes only the R2 read-stream adapter.
  try {
    let r2StreamCalled = false;
    const mockR2Adapter = () => ({
      headObject: async () => ({
        bucket: "bucket-r2",
        objectKey: "key-r2",
        size: 100,
        etag: "etag",
        contentType: "video/mp4",
      }),
      createReadStream: async (bucket: string, key: string) => {
        void bucket;
        void key;
        r2StreamCalled = true;
        return new Readable({ read() {} });
      },
    });

    const res = await prepareValidationSource(r2AssetInput, {
      getR2Adapter: mockR2Adapter,
    });

    const source = requirePreparedSource(res, "Test 2");
    assert(!r2StreamCalled, "createReadStream must NOT be called eagerly");
    await source.createReadStream();
    assert(r2StreamCalled, "createReadStream must be called lazily");
    console.log("Test 2 Passed: R2 source lazily invokes only the R2 read-stream adapter [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 2 Failed:", err);
  }

  // 3. R2 missing object returns null.
  try {
    const mockR2Adapter = () => ({
      headObject: async () => null,
      createReadStream: async () => new Readable({ read() {} }),
    });

    const res = await prepareValidationSource(r2AssetInput, {
      getR2Adapter: mockR2Adapter,
    });

    assert(res === null, "Missing object must return null");
    console.log("Test 3 Passed: R2 missing object returns null [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 3 Failed:", err);
  }

  // 4. R2 path performs zero Google calls.
  try {
    let googleSourceCalled = false;
    const mockGoogleSource = async () => {
      googleSourceCalled = true;
      return null;
    };

    const mockR2Adapter = () => ({
      headObject: async () => ({
        bucket: "bucket-r2",
        objectKey: "key-r2",
        size: 100,
        etag: "etag",
        contentType: "video/mp4",
      }),
      createReadStream: async () => new Readable({ read() {} }),
    });

    await prepareValidationSource(r2AssetInput, {
      getR2Adapter: mockR2Adapter,
      prepareGoogleDriveSource: mockGoogleSource,
    });

    assert(!googleSourceCalled, "R2 path must perform zero Google calls");
    console.log("Test 4 Passed: R2 path performs zero Google calls [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 4 Failed:", err);
  }

  // 5. GOOGLE_DRIVE path performs zero R2 adapter calls.
  try {
    let r2AdapterCalled = false;
    const mockR2Adapter = () => {
      r2AdapterCalled = true;
      throw new Error("R2 adapter should not be called");
    };

    const mockGoogleSource = async () => {
      return {
        metadata: {
          bucket: "folder-456",
          objectKey: "drive-file-123",
          size: 100,
          etag: "",
          contentType: "video/mp4",
        },
        createReadStream: async () => new Readable({ read() {} }),
      };
    };

    const res = await prepareValidationSource(validAssetInput, {
      getR2Adapter: mockR2Adapter,
      prepareGoogleDriveSource: mockGoogleSource,
    });

    assert(res !== null, "Google Drive source resolved");
    assert(!r2AdapterCalled, "Google Drive path must perform zero R2 adapter calls");
    console.log("Test 5 Passed: GOOGLE_DRIVE path performs zero R2 adapter calls [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 5 Failed:", err);
  }

  // 6. Unknown provider fails with UNSUPPORTED_STORAGE_PROVIDER.
  try {
    const unknownAsset: ValidationSourceAssetInput = {
      ...validAssetInput,
      provider: "UNKNOWN_PROVIDER",
    };

    let failed = false;
    try {
      await prepareValidationSource(unknownAsset);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "UNSUPPORTED_STORAGE_PROVIDER", "Expected UNSUPPORTED_STORAGE_PROVIDER error");
    }
    assert(failed, "Unknown provider must throw error");
    console.log("Test 6 Passed: Unknown provider fails with UNSUPPORTED_STORAGE_PROVIDER [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 6 Failed:", err);
  }

  // 7. Missing Drive connection becomes GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getActiveConnection: async () => null,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assertNoLeak(err);
    }
    assert(failed, "Missing Drive connection must fail");
    console.log("Test 7 Passed: Missing Drive connection becomes GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 7 Failed:", err);
  }

  // 8. Credential decryption failure is sanitized.
  try {
    const decryptMock = () => {
      throw new Error("Google OAuth expired token signature 999");
    };

    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        decryptRefreshToken: decryptMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assertNoLeak(err);
    }
    assert(failed, "Decryption failure must be sanitized");
    console.log("Test 8 Passed: Credential decryption failure is sanitized [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 8 Failed:", err);
  }

  // 9. Access-token refresh failure is sanitized.
  try {
    const tokenMock = async () => {
      throw new Error("refresh-token-abc is expired");
    };

    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getAccessToken: tokenMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assertNoLeak(err);
    }
    assert(failed, "Access token refresh failure must be sanitized");
    console.log("Test 9 Passed: Access-token refresh failure is sanitized [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 9 Failed:", err);
  }

  // 10. Blank Drive folder is rejected safely.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getActiveConnection: async () => ({
          ...mockConnection,
          driveFolderId: "   ",
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assertNoLeak(err);
    }
    assert(failed, "Blank Drive folder must be rejected");
    console.log("Test 10 Passed: Blank Drive folder is rejected safely [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 10 Failed:", err);
  }

  // 11. Connection folder differing from asset.bucket is rejected safely.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getActiveConnection: async () => ({
          ...mockConnection,
          driveFolderId: "changed-folder-id",
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assertNoLeak(err);
    }
    assert(failed, "Different connection folder must be rejected");
    console.log("Test 11 Passed: Connection folder differing from asset.bucket is rejected safely [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 11 Failed:", err);
  }

  // 12. Temporary uploads/... objectKey is rejected before Google calls.
  try {
    const tempAsset: ValidationSourceAssetInput = {
      ...validAssetInput,
      objectKey: "uploads/user-123/video.mp4",
    };

    let metadataCalled = false;
    const metadataMock = async () => {
      metadataCalled = true;
      return mockMetadata;
    };

    let failed = false;
    try {
      await prepareGoogleDriveSource(tempAsset, {
        ...defaultDeps,
        getFileMetadata: metadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assert(!metadataCalled, "Metadata API must not be called for temporary objectKey");
      assertNoLeak(err);
    }
    assert(failed, "Temporary objectKey must be rejected");
    console.log("Test 12 Passed: Temporary uploads/... objectKey is rejected before Google calls [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 12 Failed:", err);
  }

  // 13. Malformed Drive file ID is rejected before Google calls.
  try {
    const malformedAsset: ValidationSourceAssetInput = {
      ...validAssetInput,
      objectKey: "drive-file@invalid",
    };

    let metadataCalled = false;
    const metadataMock = async () => {
      metadataCalled = true;
      return mockMetadata;
    };

    let failed = false;
    try {
      await prepareGoogleDriveSource(malformedAsset, {
        ...defaultDeps,
        getFileMetadata: metadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
      assert(!metadataCalled, "Metadata API must not be called for malformed objectKey");
      assertNoLeak(err);
    }
    assert(failed, "Malformed Drive file ID must be rejected");
    console.log("Test 13 Passed: Malformed Drive file ID is rejected before Google calls [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 13 Failed:", err);
  }

  // 14. Missing Drive metadata returns null.
  try {
    const res = await prepareGoogleDriveSource(validAssetInput, {
      ...defaultDeps,
      getFileMetadata: async () => null,
    });

    assert(res === null, "Missing Drive metadata must return null");
    console.log("Test 14 Passed: Missing Drive metadata returns null [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 14 Failed:", err);
  }

  // 15. Trashed Drive metadata returns null.
  try {
    const res = await prepareGoogleDriveSource(validAssetInput, {
      ...defaultDeps,
      getFileMetadata: async () => ({
        ...mockMetadata,
        trashed: true,
      }),
    });

    assert(res === null, "Trashed Drive metadata must return null");
    console.log("Test 15 Passed: Trashed Drive metadata returns null [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 15 Failed:", err);
  }

  // 16. Wrong metadata.id produces STORAGE_BINDING_MISMATCH.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getFileMetadata: async () => ({
          ...mockMetadata,
          id: "mismatched-file-id",
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof MediaValidationError, "Expected MediaValidationError");
      assert((err as MediaValidationError).code === "STORAGE_BINDING_MISMATCH", "Code mismatch");
      assert((err as MediaValidationError).message === "The uploaded file does not match its recorded storage binding.", "Message mismatch");
      assertNoLeak(err);
    }
    assert(failed, "Mismatched metadata.id must throw");
    console.log("Test 16 Passed: Wrong metadata.id produces STORAGE_BINDING_MISMATCH [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 16 Failed:", err);
  }

  // 17. Wrong appProperties.assetId produces STORAGE_BINDING_MISMATCH.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getFileMetadata: async () => ({
          ...mockMetadata,
          appProperties: {
            assetId: "mismatched-asset-id",
          },
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof MediaValidationError, "Expected MediaValidationError");
      assert((err as MediaValidationError).code === "STORAGE_BINDING_MISMATCH", "Code mismatch");
      assert((err as MediaValidationError).message === "The uploaded file does not match its recorded storage binding.", "Message mismatch");
      assertNoLeak(err);
    }
    assert(failed, "Mismatched appProperties.assetId must throw");
    console.log("Test 17 Passed: Wrong appProperties.assetId produces STORAGE_BINDING_MISMATCH [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 17 Failed:", err);
  }

  // 18. Wrong metadata parent produces STORAGE_BINDING_MISMATCH.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getFileMetadata: async () => ({
          ...mockMetadata,
          parents: ["mismatched-folder-id"],
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof MediaValidationError, "Expected MediaValidationError");
      assert((err as MediaValidationError).code === "STORAGE_BINDING_MISMATCH", "Code mismatch");
      assert((err as MediaValidationError).message === "The uploaded file does not match its recorded storage binding.", "Message mismatch");
      assertNoLeak(err);
    }
    assert(failed, "Mismatched parents must throw");
    console.log("Test 18 Passed: Wrong metadata parent produces STORAGE_BINDING_MISMATCH [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 18 Failed:", err);
  }

  // 19. Wrong filename produces STORAGE_BINDING_MISMATCH.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getFileMetadata: async () => ({
          ...mockMetadata,
          name: "mismatched-video.mov",
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof MediaValidationError, "Expected MediaValidationError");
      assert((err as MediaValidationError).code === "STORAGE_BINDING_MISMATCH", "Code mismatch");
      assert((err as MediaValidationError).message === "The uploaded file does not match its recorded storage binding.", "Message mismatch");
      assertNoLeak(err);
    }
    assert(failed, "Mismatched file name must throw");
    console.log("Test 19 Passed: Wrong filename produces STORAGE_BINDING_MISMATCH [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 19 Failed:", err);
  }

  // 20. Wrong MIME type produces STORAGE_BINDING_MISMATCH.
  try {
    let failed = false;
    try {
      await prepareGoogleDriveSource(validAssetInput, {
        ...defaultDeps,
        getFileMetadata: async () => ({
          ...mockMetadata,
          mimeType: "video/quicktime",
        }),
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof MediaValidationError, "Expected MediaValidationError");
      assert((err as MediaValidationError).code === "STORAGE_BINDING_MISMATCH", "Code mismatch");
      assert((err as MediaValidationError).message === "The uploaded file does not match its recorded storage binding.", "Message mismatch");
      assertNoLeak(err);
    }
    assert(failed, "Mismatched mime type must throw");
    console.log("Test 20 Passed: Wrong MIME type produces STORAGE_BINDING_MISMATCH [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 20 Failed:", err);
  }

  // 21. Valid metadata maps exactly into ObjectMetadata and creates the exact mocked stream using the correct file ID.
  try {
    let streamFetchedWithFileId = "";
    const res = await prepareGoogleDriveSource(validAssetInput, {
      ...defaultDeps,
      createReadStream: async (accessToken: string, fileId: string) => {
        void accessToken;
        streamFetchedWithFileId = fileId;
        return new Readable({ read() {} });
      },
    });

    const source = requirePreparedSource(res, "Test 21");
    assert(source.metadata.bucket === "folder-456", "Bucket matches");
    assert(source.metadata.objectKey === "drive-file-123", "ObjectKey matches");
    assert(source.metadata.size === 10485760, "Size matches");
    assert(source.metadata.etag === "md5-checksum-abc", "Etag matches");
    assert(source.metadata.contentType === "video/mp4", "ContentType matches");
    assert(source.metadata.lastModified?.getTime() === new Date("2026-07-16T12:00:00Z").getTime(), "LastModified matches");

    await source.createReadStream();
    assert(streamFetchedWithFileId === "drive-file-123", "Stream created with correct file ID");
    console.log("Test 21 Passed: Valid metadata maps exactly into ObjectMetadata [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 21 Failed:", err);
  }

  // 22. Download-provider failure becomes only GOOGLE_DRIVE_VALIDATION_DOWNLOAD_FAILED.
  try {
    const res = await prepareGoogleDriveSource(validAssetInput, {
      ...defaultDeps,
      createReadStream: async () => {
        throw new Error("Network timeout / credentials invalid error 999");
      },
    });

    const source = requirePreparedSource(res, "Test 22");

    let failed = false;
    try {
      await source.createReadStream();
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_VALIDATION_DOWNLOAD_FAILED", "Expected GOOGLE_DRIVE_VALIDATION_DOWNLOAD_FAILED error");
      assertNoLeak(err);
    }
    assert(failed, "Download failure must throw");
    console.log("Test 22 Passed: Download-provider failure becomes only GOOGLE_DRIVE_VALIDATION_DOWNLOAD_FAILED [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 22 Failed:", err);
  }

  console.log(`\nGoogle Drive Video Validation complete. Passed: ${passedCount}/22`);

  if (passedCount !== 22) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All Google Drive validation constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in video validation test suite:", errorMsg);
  process.exit(1);
});
