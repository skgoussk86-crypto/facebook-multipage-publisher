"use client";

import React, { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function MockFacebookLoginContent() {
  const searchParams = useSearchParams();
  const state = searchParams.get("state") || "";
  const redirectUri = searchParams.get("redirect_uri") || "/api/auth/facebook/callback";

  // State to simulate granular permission selection
  const [grantShowList, setGrantShowList] = useState(true);
  const [grantReadEngagement, setGrantReadEngagement] = useState(true);
  const [grantPublishPosts, setGrantPublishPosts] = useState(true);

  // Compute overall target URL based on checkboxes
  const getAuthUrl = (action: "approve" | "cancel") => {
    if (action === "cancel") {
      return `${redirectUri}?error=access_denied&state=${state}`;
    }
    
    const missingPermissions = !grantPublishPosts || !grantShowList || !grantReadEngagement;
    const permissionsQuery = missingPermissions ? "missing" : "all";
    // Using a pure, static mock code string to comply with strict linter requirements
    return `${redirectUri}?code=mock_authorization_code_987654321&state=${state}&permissions_granted=${permissionsQuery}`;
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 font-sans p-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
        
        {/* Header Branding */}
        <div className="bg-zinc-950 p-6 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded bg-blue-600 flex items-center justify-center text-white font-extrabold text-lg select-none">
              f
            </div>
            <span className="font-bold tracking-tight text-sm text-zinc-300 font-mono">META GRAPH SIMULATOR</span>
          </div>
          <span className="text-[10px] bg-amber-500/20 text-amber-500 border border-amber-500/30 px-2 py-0.5 rounded font-bold uppercase tracking-wider">
            Sandbox Mode
          </span>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-lg font-bold text-white">Log in with Facebook</h2>
            <p className="text-xs text-zinc-400 leading-relaxed px-4">
              <span className="font-semibold text-indigo-400">FB Multi-Page Publisher</span> is requesting access to your managed pages.
            </p>
          </div>

          {/* Permissions Accordion/Box */}
          <div className="bg-zinc-950 border border-zinc-850 rounded-xl p-4 space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500 font-bold border-b border-zinc-900 pb-2">
              Permissions Requested
            </h3>

            <div className="space-y-3.5 text-xs">
              {/* Profile info */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold text-zinc-200 block">Public Profile Info</span>
                  <span className="text-[10px] text-zinc-500">Retrieve administrator name and picture.</span>
                </div>
                <input
                  type="checkbox"
                  checked={true}
                  disabled
                  className="rounded bg-zinc-900 border-zinc-800 text-blue-600 focus:ring-blue-600 h-4 w-4 opacity-50 cursor-not-allowed"
                />
              </div>

              {/* Show list */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold text-zinc-200 block">pages_show_list</span>
                  <span className="text-[10px] text-zinc-500">Read the list of pages you manage.</span>
                </div>
                <input
                  type="checkbox"
                  checked={grantShowList}
                  onChange={(e) => setGrantShowList(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-800 text-blue-600 focus:ring-blue-600 h-4 w-4"
                />
              </div>

              {/* Read engagement */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold text-zinc-200 block">pages_read_engagement</span>
                  <span className="text-[10px] text-zinc-500">Read analytical content and category details.</span>
                </div>
                <input
                  type="checkbox"
                  checked={grantReadEngagement}
                  onChange={(e) => setGrantReadEngagement(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-800 text-blue-600 focus:ring-blue-600 h-4 w-4"
                />
              </div>

              {/* Publish posts */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold text-zinc-200 block">pages_manage_posts & publish_video</span>
                  <span className="text-[10px] text-zinc-500">Publish reels and standard videos to your Pages.</span>
                </div>
                <input
                  type="checkbox"
                  checked={grantPublishPosts}
                  onChange={(e) => setGrantPublishPosts(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-800 text-blue-600 focus:ring-blue-600 h-4 w-4"
                />
              </div>
            </div>
          </div>

          <div className="text-[11px] text-zinc-500 leading-relaxed bg-zinc-950/40 p-3 rounded-lg border border-zinc-850">
            <span className="text-amber-500 font-bold block mb-0.5 font-mono uppercase tracking-wider text-[9px]">Simulation Tip:</span>
            Uncheck the <code className="text-zinc-300 font-semibold font-mono">pages_manage_posts & publish_video</code> box to simulate a <strong className="text-zinc-300 font-medium">Permission Missing</strong> state on the dashboard overview.
          </div>
        </div>

        {/* Buttons Actions */}
        <div className="bg-zinc-950 p-6 border-t border-zinc-800 flex justify-end gap-3 text-xs">
          <a
            href={getAuthUrl("cancel")}
            className="px-4 py-2 border border-zinc-850 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 font-semibold rounded-lg transition"
          >
            Cancel
          </a>
          <a
            href={getAuthUrl("approve")}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition shadow-md shadow-blue-600/10"
          >
            Authorize App Access
          </a>
        </div>

      </div>
    </div>
  );
}

export default function MockFacebookLogin() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 font-sans p-4">
        <div className="text-sm font-mono text-zinc-500">Loading auth context...</div>
      </div>
    }>
      <MockFacebookLoginContent />
    </Suspense>
  );
}
