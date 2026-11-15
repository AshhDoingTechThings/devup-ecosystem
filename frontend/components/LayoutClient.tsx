"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { Navbar } from "@/components/Navbar";
import MobileBottomNav from "@/components/MobileBottomNav";
import { Footer } from "@/components/Footer";
import SmoothScrollProvider from "@/components/SmoothScrollProvider";
import { Providers } from "@/lib/providers";
import { AuthProvider } from "@/lib/auth/AuthProvider";
import MobilePageTransition from "@/components/mobile/MobilePageTransition";

const IntroAnimation = dynamic(
  () => import("@/components/IntroAnimation"),
  { ssr: false }
);

import { AuthGateProvider } from "@/hooks/useAuthGate";
import AuthModal from "@/components/auth/AuthModal";

export default function LayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    // Suppress THREE.Clock deprecation warning caused by @react-three/fiber internals
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (args[0] && typeof args[0] === 'string' && (
        args[0].includes('THREE.Clock: This module has been deprecated') ||
        args[0].includes('WebGL context lost') ||
        args[0].includes('THREE.WebGLRenderer: Context Lost.')
      )) {
        return;
      }
      originalWarn(...args);
    };

    return () => {
      console.warn = originalWarn;
    };
  }, []);

  const pathname = usePathname();

  /**
   * The startup workspace at /s/[code] is a self-contained app with its own
   * sidebar and navigation. The marketing chrome — navbar, footer, mobile tab
   * bar, intro animation — is hidden there so the whole viewport belongs to it.
   */
  // The finance portal (/finance) is the same kind of self-contained app.
  const isWorkspace = (pathname?.startsWith("/s/") || pathname === "/finance" || pathname?.startsWith("/finance/")) ?? false;

  // The root layout paints a full-screen #intro-overlay that only IntroAnimation
  // removes — and IntroAnimation isn't rendered in these apps. Without this, a
  // first visit straight to /s/<code> or /finance (a link in an email, a new tab)
  // stays a blank black screen.
  useEffect(() => {
    if (!isWorkspace) return;
    const overlay = document.getElementById("intro-overlay");
    if (overlay) overlay.style.display = "none";
  }, [isWorkspace]);

  if (isWorkspace) {
    return (
      <Providers>
        <AuthProvider>
          <AuthGateProvider>
            <main className="relative z-10">{children}</main>
            <AuthModal />
          </AuthGateProvider>
        </AuthProvider>
      </Providers>
    );
  }

  return (
    <Providers>
      <AuthProvider>
        <AuthGateProvider>
          <SmoothScrollProvider>
            <IntroAnimation />
            <Navbar />
            <MobilePageTransition>
              <main className="flex-1 relative z-10">{children}</main>
            </MobilePageTransition>
            <MobileBottomNav />
            <Footer />
            <AuthModal />
          </SmoothScrollProvider>
        </AuthGateProvider>
      </AuthProvider>
    </Providers>
  );
}
