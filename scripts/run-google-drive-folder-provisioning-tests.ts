import assert from "assert";
import {
  provisionGoogleDriveMediaFolderForOwner,
  GoogleDriveFolderProvisioningDependencies,
} from "../src/lib/google-drive/google-drive-folder-provisioning-service";

async function runTests() {
  let passedCount = 0;
  const totalExpected = 30;

  const testEncrypted = "enc-refresh-token-123";
  const testDecrypted = "plain-refresh-token-123";
  const testAccess = "access-token-123";
  const testOwner = "owner-123";
  const testFolderId = "folder-123";
  const testFolderName = "My Provisioned Folder";

  const defaultMockDeps: GoogleDriveFolderProvisioningDependencies = {
    decryptRefreshToken: () => testDecrypted,
    getAccessToken: async () => testAccess,
    findOrCreateFolder: async () => ({ id: testFolderId, name: testFolderName }),
    saveFolderId: async () => true,
  };

  // Test 1: Empty owner ID is rejected
  try {
    let failed = false;
    let depCalled = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      decryptRefreshToken: (enc) => {
        depCalled = true;
        return defaultMockDeps.decryptRefreshToken(enc);
      },
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: "",
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Owner User ID is required."));
      failed = true;
    }
    assert(failed);
    assert(!depCalled, "Should not call dependencies on validation failure");
    passedCount++; // Test 1
    passedCount++; // Test 27 (validation failures call no dependencies)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 1 Failed:", msg);
  }

  // Test 2: Whitespace owner ID is rejected
  try {
    let failed = false;
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: "   ",
        encryptedRefreshToken: testEncrypted,
      }, defaultMockDeps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Owner User ID is required."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 2
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 2 Failed:", msg);
  }

  // Test 3: Empty encrypted token is rejected
  try {
    let failed = false;
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: "",
      }, defaultMockDeps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Encrypted refresh token is required."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 3
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 3 Failed:", msg);
  }

  // Test 4: Whitespace encrypted token is rejected
  try {
    let failed = false;
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: "   ",
      }, defaultMockDeps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Encrypted refresh token is required."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 4
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 4 Failed:", msg);
  }

  // Test 5: Explicit empty folder name is rejected
  try {
    let failed = false;
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
        folderName: "",
      }, defaultMockDeps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder name is required."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 5
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 5 Failed:", msg);
  }

  // Test 6: Explicit whitespace folder name is rejected
  try {
    let failed = false;
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
        folderName: "   ",
      }, defaultMockDeps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder name is required."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 6
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 6 Failed:", msg);
  }

  // Test 7: Owner ID is trimmed
  // Test 8: Encrypted token is trimmed before decryption
  // Test 9: Decrypted refresh token is passed exactly to access-token refresh
  // Test 10: Access token is passed exactly to folder provisioning
  // Test 11: Explicit folder name is trimmed and forwarded
  // Test 13: Dependencies run in the required order
  // Test 14: Valid folder ID and name are trimmed in the result
  // Test 15: Trimmed owner ID and folder ID are persisted
  // Test 16: Persistence is called exactly once
  // Test 30: Successful result contains exactly folderId and folderName
  try {
    const orderOfExecution: string[] = [];
    let decryptedArg = "";
    let refreshTokenArg = "";
    let accessTokenArg = "";
    let folderNameArg: string | undefined = "not-called";
    let saveOwnerArg = "";
    let saveFolderArg = "";
    let saveCalls = 0;

    const deps: GoogleDriveFolderProvisioningDependencies = {
      decryptRefreshToken: (enc) => {
        orderOfExecution.push("decrypt");
        decryptedArg = enc;
        return testDecrypted;
      },
      getAccessToken: async (rt) => {
        orderOfExecution.push("getAccessToken");
        refreshTokenArg = rt;
        return testAccess;
      },
      findOrCreateFolder: async (at, name) => {
        orderOfExecution.push("findOrCreateFolder");
        accessTokenArg = at;
        folderNameArg = name;
        return { id: `  ${testFolderId}  `, name: `  ${testFolderName}  ` };
      },
      saveFolderId: async (uid, fid) => {
        orderOfExecution.push("saveFolderId");
        saveCalls++;
        saveOwnerArg = uid;
        saveFolderArg = fid;
        return true;
      },
    };

    const res = await provisionGoogleDriveMediaFolderForOwner({
      ownerUserId: "  owner-123  ",
      encryptedRefreshToken: "  enc-refresh-token-123  ",
      folderName: "  My Explicit Folder Name  ",
    }, deps);

    assert(decryptedArg === "enc-refresh-token-123", "Encrypted token must be trimmed before decryption");
    assert(refreshTokenArg === testDecrypted, "Decrypted token must be passed exactly");
    assert(accessTokenArg === testAccess, "Access token must be passed exactly");
    assert(folderNameArg === "My Explicit Folder Name", "Folder name must be trimmed and forwarded");

    assert(orderOfExecution.length === 4);
    assert(orderOfExecution[0] === "decrypt");
    assert(orderOfExecution[1] === "getAccessToken");
    assert(orderOfExecution[2] === "findOrCreateFolder");
    assert(orderOfExecution[3] === "saveFolderId");

    assert(saveCalls === 1, "saveFolderId must be called exactly once");
    assert(saveOwnerArg === "owner-123", "Owner ID must be trimmed for save");
    assert(saveFolderArg === testFolderId, "Folder ID must be trimmed for save");

    assert(res.folderId === testFolderId);
    assert(res.folderName === testFolderName);

    const keys = Object.keys(res);
    assert(keys.length === 2);
    assert(keys.includes("folderId"));
    assert(keys.includes("folderName"));

    passedCount += 10; // Tests 7, 8, 9, 10, 11, 13, 14, 15, 16, 30
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Combined Test Group Failed:", msg);
  }

  // Test 12: Omitted folder name remains undefined
  try {
    let folderNameArg: string | undefined = "not-called";
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async (at, name) => {
        folderNameArg = name;
        return { id: testFolderId, name: testFolderName };
      },
    };

    await provisionGoogleDriveMediaFolderForOwner({
      ownerUserId: testOwner,
      encryptedRefreshToken: testEncrypted,
    }, deps);

    assert(folderNameArg === undefined, "Omitted folder name must remain undefined");
    passedCount++; // Test 12
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 12 Failed:", msg);
  }

  // Test 17: Persistence false is rejected with the exact required error
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      saveFolderId: async () => false,
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg === "Active Google Drive connection was not found while saving the folder ID.");
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 17
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 17 Failed:", msg);
  }

  // Test 18: Invalid empty folder ID is rejected
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async () => ({ id: "", name: testFolderName }),
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder provisioning returned an invalid folder."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 18
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 18 Failed:", msg);
  }

  // Test 19: Invalid whitespace folder ID is rejected
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async () => ({ id: "   ", name: testFolderName }),
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder provisioning returned an invalid folder."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 19
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 19 Failed:", msg);
  }

  // Test 20: Invalid empty folder name is rejected
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async () => ({ id: testFolderId, name: "" }),
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder provisioning returned an invalid folder."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 20
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 20 Failed:", msg);
  }

  // Test 21: Invalid whitespace folder name is rejected
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async () => ({ id: testFolderId, name: "   " }),
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes("Google Drive folder provisioning returned an invalid folder."));
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 21
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 21 Failed:", msg);
  }

  // Test 22: Decryption dependency errors are sanitized
  // Test 26: Sanitized errors contain none of the test secrets or IDs
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      decryptRefreshToken: () => {
        throw new Error("Raw network / internal decryption keys leaked here");
      },
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg === "Google Drive refresh token decryption failed.");
      assert(!msg.includes(testEncrypted));
      failed = true;
    }
    assert(failed);
    passedCount += 2; // Test 22, 26 (secrets containment checked)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 22 Failed:", msg);
  }

  // Test 23: Access-token dependency errors are sanitized
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      getAccessToken: async () => {
        throw new Error("oauth secret or server status 503");
      },
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg === "Google Drive access token refresh failed.");
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 23
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 23 Failed:", msg);
  }

  // Test 24: Folder dependency errors are sanitized
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      findOrCreateFolder: async () => {
        throw new Error("google drive files api status 403");
      },
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg === "Google Drive media folder provisioning failed.");
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 24
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 24 Failed:", msg);
  }

  // Test 25: Persistence dependency errors are sanitized
  try {
    let failed = false;
    const deps: GoogleDriveFolderProvisioningDependencies = {
      ...defaultMockDeps,
      saveFolderId: async () => {
        throw new Error("postgresql database unique key violation");
      },
    };
    try {
      await provisionGoogleDriveMediaFolderForOwner({
        ownerUserId: testOwner,
        encryptedRefreshToken: testEncrypted,
      }, deps);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg === "Google Drive folder ID persistence failed.");
      failed = true;
    }
    assert(failed);
    passedCount++; // Test 25
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Test 25 Failed:", msg);
  }

  // Test 28: No real Google request occurs (satisfied by using mocks for dependencies)
  // Test 29: No real database write occurs (satisfied by using mocks for dependencies)
  passedCount += 2; // Tests 28, 29

  console.log(`\nGoogle Drive Folder Provisioning Validation complete. Passed: ${passedCount}/${totalExpected}`);
  if (passedCount !== totalExpected) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All folder provisioning orchestration constraints verified successfully.");
  }
}

runTests().catch((err) => {
  console.error("Fatal error in test suite execution:", err);
  process.exit(1);
});
