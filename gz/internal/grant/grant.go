// Package grant stores a profile's login grant (design-agent-access.md Q24):
// in the OS keychain (macOS Keychain, Windows Credential Manager, Linux
// Secret Service), or in a file only the user can read where there's none
// (CI, containers).
package grant

import (
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// ErrNotFound means the profile has no stored grant.
var ErrNotFound = errors.New("no grant stored for this profile")

// Store keeps one grant per profile.
type Store interface {
	Get(profile string) (string, error)
	Set(profile, grant string) error
	Delete(profile string) error
}

// Keyring is the OS keychain, as go-keyring exposes it.
type Keyring interface {
	Get(service, user string) (string, error)
	Set(service, user, password string) error
	Delete(service, user string) error
}

// service is the keychain service name gz's grants are stored under.
const service = "gz"

type keychainStore struct{ kr Keyring }

// NewKeychain stores grants in kr.
func NewKeychain(kr Keyring) Store { return keychainStore{kr} }

func (s keychainStore) Get(profile string) (string, error) {
	v, err := s.kr.Get(service, profile)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func (s keychainStore) Set(profile, grant string) error { return s.kr.Set(service, profile, grant) }

func (s keychainStore) Delete(profile string) error {
	err := s.kr.Delete(service, profile)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

type fileStore struct{ dir string }

// NewFile stores grants as files in dir: the folder 0700, each file 0600.
func NewFile(dir string) Store { return fileStore{dir} }

func (s fileStore) path(profile string) string {
	return filepath.Join(s.dir, url.PathEscape(profile)+".grant")
}

func (s fileStore) Get(profile string) (string, error) {
	data, err := os.ReadFile(s.path(profile))
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrNotFound
	}
	return string(data), err
}

func (s fileStore) Set(profile, grant string) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	// Write to a temp file created 0600, then rename, so the grant is never
	// readable by others, even briefly.
	tmp, err := os.CreateTemp(s.dir, ".grant-*")
	if err != nil {
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if _, err := tmp.WriteString(grant); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), s.path(profile))
}

func (s fileStore) Delete(profile string) error {
	err := os.Remove(s.path(profile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// osKeyring adapts go-keyring's package functions to Keyring.
type osKeyring struct{}

func (osKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }
func (osKeyring) Set(s, u, p string) error        { return keyring.Set(s, u, p) }
func (osKeyring) Delete(s, u string) error        { return keyring.Delete(s, u) }

// Choose returns the keychain store when kr answers, and the file store in
// dir otherwise. A lookup that finds nothing still means the keychain works.
func Choose(kr Keyring, dir string) Store {
	if _, err := kr.Get(service, "gz-keychain-probe"); err == nil || errors.Is(err, keyring.ErrNotFound) {
		return NewKeychain(kr)
	}
	return NewFile(dir)
}

// Default is the store for this machine.
func Default(dir string) Store { return Choose(osKeyring{}, dir) }
