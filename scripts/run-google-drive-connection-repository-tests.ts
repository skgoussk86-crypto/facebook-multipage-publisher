import assert from "assert";
import {
  saveDriveFolderIdForOwner,
  GoogleDriveFolderIdPersistence,
  GoogleDriveFolderIdPersistenceInput,
} from "../src/lib/google-drive/google-drive-connection-repository";

async function runTests() {
  let passedCount = 0;

  // Test 1: Empty owner ID is rejected
  try {
    let failed = false;
    let persistenceCalled = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => {
        persistenceCalled = true;
        return 1;
      },
    };
    try {
      await saveDriveFolderIdForOwner("", "folder-123", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Owner User ID is required."));
      failed = true;
    }
    assert(failed, "Empty owner ID must be rejected");
    assert(!persistenceCalled, "Persistence must not be called on validation failure");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 1 Failed:", message);
  }

  // Test 2: Whitespace owner ID is rejected
  try {
    let failed = false;
    let persistenceCalled = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => {
        persistenceCalled = true;
        return 1;
      },
    };
    try {
      await saveDriveFolderIdForOwner("   ", "folder-123", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Owner User ID is required."));
      failed = true;
    }
    assert(failed, "Whitespace owner ID must be rejected");
    assert(!persistenceCalled, "Persistence must not be called on validation failure");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 2 Failed:", message);
  }

  // Test 3: Empty folder ID is rejected
  try {
    let failed = false;
    let persistenceCalled = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => {
        persistenceCalled = true;
        return 1;
      },
    };
    try {
      await saveDriveFolderIdForOwner("owner-123", "", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Drive folder ID is required."));
      failed = true;
    }
    assert(failed, "Empty folder ID must be rejected");
    assert(!persistenceCalled, "Persistence must not be called on validation failure");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 3 Failed:", message);
  }

  // Test 4: Whitespace folder ID is rejected
  try {
    let failed = false;
    let persistenceCalled = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => {
        persistenceCalled = true;
        return 1;
      },
    };
    try {
      await saveDriveFolderIdForOwner("owner-123", "   ", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Drive folder ID is required."));
      failed = true;
    }
    assert(failed, "Whitespace folder ID must be rejected");
    assert(!persistenceCalled, "Persistence must not be called on validation failure");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 4 Failed:", message);
  }

  // Test 5: Owner ID is trimmed before persistence
  // Test 6: Folder ID is trimmed before persistence
  // Test 7: Persistence is called exactly once
  // Test 12: The persistence input contains exactly ownerUserId and driveFolderId
  // Test 13: The persistence input contains no token, email, revocation, or connection-time fields
  try {
    let calls = 0;
    const capturedInputCapture: {
      value: GoogleDriveFolderIdPersistenceInput | null;
    } = {
      value: null,
    };
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async (input) => {
        calls++;
        capturedInputCapture.value = input;
        return 1;
      },
    };

    await saveDriveFolderIdForOwner("  owner-123  ", "  folder-123  ", fakePersist);

    const capturedInput = capturedInputCapture.value;

    if (capturedInput === null) {
      throw new Error("Persistence input was not captured.");
    }

    assert(calls === 1, "Persistence must be called exactly once");

    assert(
      capturedInput.ownerUserId === "owner-123",
      "Owner ID must be trimmed"
    );

    assert(
      capturedInput.driveFolderId === "folder-123",
      "Folder ID must be trimmed"
    );

    const keys = Object.keys(capturedInput);
    assert(keys.length === 2, "Persistence input must contain exactly 2 keys");
    assert(keys.includes("ownerUserId"), "Must contain ownerUserId");
    assert(keys.includes("driveFolderId"), "Must contain driveFolderId");

    passedCount += 5; // Tests 5, 6, 7, 12, 13
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 5/6/7/12/13 Failed:", message);
  }

  // Test 8: Update count 1 returns true
  try {
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => 1,
    };
    const res = await saveDriveFolderIdForOwner("owner-123", "folder-123", fakePersist);
    assert(res === true, "Should return true for count 1");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 8 Failed:", message);
  }

  // Test 9: Update count 0 returns false
  try {
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => 0,
    };
    const res = await saveDriveFolderIdForOwner("owner-123", "folder-123", fakePersist);
    assert(res === false, "Should return false for count 0");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 9 Failed:", message);
  }

  // Test 10: Negative update count is rejected
  try {
    let failed = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => -1,
    };
    try {
      await saveDriveFolderIdForOwner("owner-123", "folder-123", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Unexpected Google Drive connection update count."));
      failed = true;
    }
    assert(failed, "Negative count should throw");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 10 Failed:", message);
  }

  // Test 11: Update count greater than 1 is rejected
  try {
    let failed = false;
    const fakePersist: GoogleDriveFolderIdPersistence = {
      updateActiveOwnerFolderId: async () => 2,
    };
    try {
      await saveDriveFolderIdForOwner("owner-123", "folder-123", fakePersist);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Unexpected Google Drive connection update count."));
      failed = true;
    }
    assert(failed, "Count > 1 should throw");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 11 Failed:", message);
  }

  // Test 14: Validation failures do not call persistence (already checked in Tests 1-4)
  // Test 15: No real database write occurs (satisfied by all tests using fakePersist)
  passedCount += 2; // Tests 14, 15

  console.log(`\nGoogle Drive Connection Repository Validation complete. Passed: ${passedCount}/15`);
  if (passedCount !== 15) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All folder ID persistence constraints verified successfully.");
  }
}

runTests().catch((err) => {
  console.error("Fatal error in test suite execution:", err);
  process.exit(1);
});
