package benchmarks

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/noxiouz/zapctx/ctxlog"
	pb "github.com/sonm-io/core/proto"
	"go.uber.org/zap"
)

const (
	// benchmark IDs that must be handled as values from hosts.
	CPUCores    = 2
	RamSize     = 3
	StorageSize = 4
	NetworkIn   = 5
	NetworkOut  = 6
	GPUCount    = 7
	GPUMem      = 8

	BenchIDEnvParamName = "SONM_BENCHMARK_ID"
	CPUCountBenchParam  = "SONM_CPU_COUNT"
	GPUVendorParam      = "SONM_GPU_TYPE"
)

type BenchList interface {
	ByID() []*pb.Benchmark
	MapByDeviceType() map[pb.DeviceType][]*pb.Benchmark
	MapByCode() map[string]*pb.Benchmark
}

type benchmarkList struct {
	byCode map[string]*pb.Benchmark
	byType map[pb.DeviceType][]*pb.Benchmark
	byID   []*pb.Benchmark
}

func (bl *benchmarkList) load(ctx context.Context, s string) error {
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("cannot parse input as URL: %v", err)
	}

	var reader io.ReadCloser
	switch u.Scheme {
	case "http", "https":
		reader, err = bl.loadURL(ctx, u.String())
	case "file":
		reader, err = bl.loadFile(ctx, u.Path)
	default:
		err = fmt.Errorf("unknown url schema for downloading: %v", u.Scheme)
	}

	if err != nil {
		return err
	}

	defer reader.Close()
	return bl.readResults(ctx, reader)
}

func (bl *benchmarkList) loadURL(ctx context.Context, url string) (io.ReadCloser, error) {
	ctxlog.G(ctx).Debug("loading benchmark list url", zap.String("url", url))

	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to download benchmarks list: got %s status", resp.Status)
	}

	return resp.Body, nil
}

func (bl *benchmarkList) loadFile(ctx context.Context, path string) (io.ReadCloser, error) {
	ctxlog.G(ctx).Debug("loading benchmark list from file", zap.String("path", path))
	return os.Open(path)
}

func (bl *benchmarkList) readResults(ctx context.Context, reader io.ReadCloser) error {
	data := make(map[string]*pb.Benchmark)
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&data); err != nil {
		return fmt.Errorf("cannot decode JSON response: %v", err)
	}

	var max uint64
	for _, bench := range data {
		if bench.ID > max {
			max = bench.ID
		}
	}
	bl.byID = make([]*pb.Benchmark, max+1)
	for _, bench := range data {

		if bench.ID >= uint64(len(bl.byID)) {
			return fmt.Errorf("malformed benchmarks list json, have %d items, but found ID %d", len(bl.byID), bench.ID)
		}
		if bl.byID[bench.ID] != nil {
			return fmt.Errorf("malformed benchmarks list json, duplicate id %d", bench.ID)
		}
		bl.byID[bench.ID] = bench
	}

	bl.byCode = data
	for code, bench := range data {
		key := bench.GetType()
		bench.Code = code

		_, ok := bl.byType[key]
		if ok {
			bl.byType[key] = append(bl.byType[key], bench)
		} else {
			bl.byType[key] = []*pb.Benchmark{bench}
		}
	}

	ctxlog.G(ctx).Debug("received benchmarks list", zap.Any("data", bl.byCode))
	return nil
}

// NewBenchmarksList returns benchmark list from external storage.
func NewBenchmarksList(ctx context.Context, cfg Config) (BenchList, error) {
	ls := &benchmarkList{
		byType: make(map[pb.DeviceType][]*pb.Benchmark),
	}

	if len(cfg.URL) == 0 {
		ctxlog.G(ctx).Debug("benchmark list loading is disabled, skipping")
		return ls, nil
	}

	if err := ls.load(ctx, cfg.URL); err != nil {
		return nil, err
	}

	return ls, nil
}

func (bl *benchmarkList) ByID() []*pb.Benchmark {
	return bl.byID
}

func (bl *benchmarkList) MapByDeviceType() map[pb.DeviceType][]*pb.Benchmark {
	return bl.byType
}

func (bl *benchmarkList) MapByCode() map[string]*pb.Benchmark {
	return bl.byCode
}

// ResultJSON describes results of single benchmark.
type ResultJSON struct {
	Result   uint64 `json:"result"`
	DeviceID string `json:"device_id"`
}

// ContainerBenchmarkResultsJSON describes JSON structure which container
// must return as result of one or many benchmarks.
// Maps benchmark code to result struct
type ContainerBenchmarkResultsJSON struct {
	Results map[string]*ResultJSON `json:"results"`
}

type Config struct {
	URL string `yaml:"url"`
}
