package grant

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zalando/go-keyring"
)

// fakeKeyring keeps values in memory, or fails every call like a machine
// without a keychain service.
type fakeKeyring struct {
	values map[string]string
	broken bool
}

var errNoService = errors.New("no keychain service")

func (f *fakeKeyring) Get(s, u string) (string, error) {
	if f.broken {
		return "", errNoService
	}
	v, ok := f.values[s+"/"+u]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return v, nil
}

func (f *fakeKeyring) Set(s, u, p string) error {
	if f.broken {
		return errNoService
	}
	f.values[s+"/"+u] = p
	return nil
}

func (f *fakeKeyring) Delete(s, u string) error {
	if f.broken {
		return errNoService
	}
	if _, ok := f.values[s+"/"+u]; !ok {
		return keyring.ErrNotFound
	}
	delete(f.values, s+"/"+u)
	return nil
}

// roundTrip saves, reads and deletes a grant through s.
func roundTrip(t *testing.T, s Store) {
	t.Helper()
	if _, err := s.Get("work"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty Get: %v", err)
	}
	if err := s.Set("work", "grant-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("work", "grant-2"); err != nil {
		t.Fatal(err)
	}
	if v, err := s.Get("work"); err != nil || v != "grant-2" {
		t.Fatalf("Get: %q %v", v, err)
	}
	if err := s.Delete("work"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("work"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: %v", err)
	}
	if err := s.Delete("work"); err != nil {
		t.Fatalf("deleting a missing grant: %v", err)
	}
}

func TestKeychainStore(t *testing.T) {
	kr := &fakeKeyring{values: map[string]string{}}
	roundTrip(t, NewKeychain(kr))
}

func TestFileStore(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "grants")
	s := NewFile(dir)
	roundTrip(t, s)
	if err := s.Set("team/site", "g"); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		return // Windows has no POSIX permission bits.
	}
	dirInfo, _ := os.Stat(dir)
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode %v", dirInfo.Mode().Perm())
	}
	fileInfo, err := os.Stat(filepath.Join(dir, "team%2Fsite.grant"))
	if err != nil {
		t.Fatal(err)
	}
	if fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", fileInfo.Mode().Perm())
	}
}

func TestChooseFallsBackToAFileWithoutAKeychain(t *testing.T) {
	dir := t.TempDir()
	if _, ok := Choose(&fakeKeyring{values: map[string]string{}}, dir).(keychainStore); !ok {
		t.Fatal("a working keychain should be used")
	}
	if _, ok := Choose(&fakeKeyring{broken: true}, dir).(fileStore); !ok {
		t.Fatal("no keychain service should fall back to the file store")
	}
}

// Runs against this machine's real keychain; opt in with GZ_TEST_KEYCHAIN=1
// (CI runners have none, or one that asks to be unlocked).
func TestRealKeychain(t *testing.T) {
	if os.Getenv("GZ_TEST_KEYCHAIN") != "1" {
		t.Skip("set GZ_TEST_KEYCHAIN=1 to test the OS keychain")
	}
	s := Choose(osKeyring{}, t.TempDir())
	if _, ok := s.(keychainStore); !ok {
		t.Fatal("no OS keychain answered")
	}
	roundTrip(t, s)
}
