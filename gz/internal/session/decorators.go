package session

import (
	"context"
	"net/http"
)

// Cloudflare Access service-token headers, the two-header mode, so
// Authorization stays free (Q15, Q23).
const (
	CFClientIDHeader     = "CF-Access-Client-Id"
	CFClientSecretHeader = "CF-Access-Client-Secret"
)

// CloudflareAccess sends a service token on every request.
func CloudflareAccess(clientID, clientSecret string) Decorator {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set(CFClientIDHeader, clientID)
		req.Header.Set(CFClientSecretHeader, clientSecret)
		return nil
	}
}

// WithBearerToken sends src's token as `Authorization: Bearer`: a Gazetta
// token behind ALB, whose JWT check reads only that header, or an Entra
// access token behind Azure Easy Auth (Q15).
func WithBearerToken(src TokenSource) Decorator {
	return func(ctx context.Context, req *http.Request) error {
		tok, err := src.Token(ctx)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		return nil
	}
}
