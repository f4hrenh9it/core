package node

import (
	"fmt"
	"io"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
	log "github.com/noxiouz/zapctx/ctxlog"
	"github.com/sonm-io/core/insonmnia/auth"
	pb "github.com/sonm-io/core/proto"
	"github.com/sonm-io/core/util"
	"golang.org/x/net/context"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type workerAPI struct {
	pb.WorkerManagementServer
	remotes *remoteOptions
	ctx     context.Context
}

func (h *workerAPI) getWorkerAddr(ctx context.Context) (*auth.Addr, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		addr := auth.NewAddrRaw(crypto.PubkeyToAddress(h.remotes.key.PublicKey), "")
		return &addr, nil
	}
	ctxAddrs, ok := md[util.WorkerAddressHeader]
	if !ok {
		addr := auth.NewAddrRaw(crypto.PubkeyToAddress(h.remotes.key.PublicKey), "")
		return &addr, nil
	}
	if len(ctxAddrs) != 1 {
		return nil, fmt.Errorf("worker address key in metadata has %d headers (exactly one required)", len(ctxAddrs))
	}
	return auth.NewAddr(ctxAddrs[0])
}

func (h *workerAPI) getClient(ctx context.Context) (pb.WorkerManagementClient, io.Closer, error) {
	addr, err := h.getWorkerAddr(ctx)
	if err != nil {
		return nil, nil, err
	}

	log.S(h.ctx).Debugf("connecting to worker on %s", addr.String())
	return h.remotes.workerCreator(ctx, addr)
}

func (h *workerAPI) intercept(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
	methodName := util.ExtractMethod(info.FullMethod)

	log.S(h.ctx).Infof("handling %s request", methodName)

	ctx = util.ForwardMetadata(ctx)
	if !strings.HasPrefix(info.FullMethod, "/sonm.WorkerManagement") {
		return handler(ctx, req)
	}

	cli, cc, err := h.getClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to worker: %s", err)
	}
	defer cc.Close()

	var (
		t        = reflect.ValueOf(cli)
		method   = t.MethodByName(methodName)
		inValues = []reflect.Value{reflect.ValueOf(ctx), reflect.ValueOf(req)}
		values   = method.Call(inValues)
	)
	if !values[1].IsNil() {
		err = values[1].Interface().(error)
	}

	return values[0].Interface(), err
}

func newWorkerAPI(opts *remoteOptions) pb.WorkerManagementServer {
	return &workerAPI{
		remotes: opts,
		ctx:     opts.ctx,
	}
}
