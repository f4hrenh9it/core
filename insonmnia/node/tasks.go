package node

import (
	"fmt"
	"io"
	"strconv"

	log "github.com/noxiouz/zapctx/ctxlog"
	"github.com/pkg/errors"
	pb "github.com/sonm-io/core/proto"
	"go.uber.org/zap"
	"golang.org/x/net/context"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type tasksAPI struct {
	ctx     context.Context
	remotes *remoteOptions
}

func (t *tasksAPI) List(ctx context.Context, req *pb.TaskListRequest) (*pb.TaskListReply, error) {
	if req.GetDealID() == nil || req.GetDealID().IsZero() {
		return nil, errors.New("deal ID is required for listing tasks")
	}
	log.G(t.ctx).Info("dealID is provided in request, performing direct request",
		zap.String("dealID", req.GetDealID().Unwrap().String()))

	dealID := req.GetDealID().Unwrap().String()
	workerClient, cc, err := t.remotes.getWorkerClientForDeal(ctx, dealID)
	if err != nil {
		return nil, err
	}
	defer cc.Close()
	deal, err := workerClient.GetDealInfo(ctx, &pb.ID{Id: req.GetDealID().Unwrap().String()})
	if err != nil {
		return nil, fmt.Errorf("failed to get deal info for deal %s: %s", dealID, err)
	}

	// merge maps of running and completed tasks
	reply := &pb.TaskListReply{
		Info: make(map[string]*pb.TaskStatusReply),
	}

	for id, task := range deal.Completed {
		reply.Info[id] = task
	}

	for id, task := range deal.Running {
		reply.Info[id] = task
	}

	return reply, nil
}

func (t *tasksAPI) Start(ctx context.Context, req *pb.StartTaskRequest) (*pb.StartTaskReply, error) {
	dealID := req.GetDealID().Unwrap().String()
	worker, cc, err := t.remotes.getWorkerClientForDeal(ctx, dealID)
	if err != nil {
		return nil, err
	}
	defer cc.Close()

	reply, err := worker.StartTask(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("failed to start task on worker: %s", err)
	}

	return reply, nil
}

func (t *tasksAPI) JoinNetwork(ctx context.Context, req *pb.JoinNetworkRequest) (*pb.NetworkSpec, error) {
	dealID := req.GetTaskID().GetDealID().Unwrap().String()
	worker, cc, err := t.remotes.getWorkerClientForDeal(ctx, dealID)
	if err != nil {
		return nil, err
	}
	defer cc.Close()

	reply, err := worker.JoinNetwork(ctx, &pb.WorkerJoinNetworkRequest{
		TaskID:    req.GetTaskID().GetId(),
		NetworkID: req.GetNetworkID(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to join network on worker: %s", err)
	}

	return reply, nil
}

func (t *tasksAPI) Status(ctx context.Context, id *pb.TaskID) (*pb.TaskStatusReply, error) {
	workerClient, cc, err := t.remotes.getWorkerClientForDeal(ctx, id.GetDealID().Unwrap().String())
	if err != nil {
		return nil, err
	}
	defer cc.Close()

	return workerClient.TaskStatus(ctx, &pb.ID{Id: id.GetId()})
}

func (t *tasksAPI) Logs(req *pb.TaskLogsRequest, srv pb.TaskManagement_LogsServer) error {
	workerClient, cc, err := t.remotes.getWorkerClientForDeal(srv.Context(), req.GetDealID().Unwrap().String())
	if err != nil {
		return err
	}
	defer cc.Close()

	logClient, err := workerClient.TaskLogs(srv.Context(), req)
	if err != nil {
		return fmt.Errorf("failed to fetch logs from worker: %s", err)
	}

	for {
		buffer, err := logClient.Recv()
		if err == io.EOF {
			return nil
		}

		if err != nil {
			return fmt.Errorf("failure during receiving logs from worker: %s", err)
		}

		err = srv.Send(buffer)
		if err != nil {
			return fmt.Errorf("failed to send log chunk request to worker: %s", err)
		}
	}
}

func (t *tasksAPI) Stop(ctx context.Context, id *pb.TaskID) (*pb.Empty, error) {
	workerClient, cc, err := t.remotes.getWorkerClientForDeal(ctx, id.GetDealID().Unwrap().String())
	if err != nil {
		return nil, err
	}
	defer cc.Close()

	return workerClient.StopTask(ctx, &pb.ID{Id: id.GetId()})
}

func (t *tasksAPI) PushTask(clientStream pb.TaskManagement_PushTaskServer) error {
	meta, err := t.extractStreamMeta(clientStream)
	if err != nil {
		return err
	}

	log.G(t.ctx).Info("handling PushTask request", zap.String("deal_id", meta.dealID))

	workerClient, cc, err := t.remotes.getWorkerClientForDeal(meta.ctx, meta.dealID)
	if err != nil {
		return err
	}
	defer cc.Close()

	workerStream, err := workerClient.PushTask(meta.ctx)
	if err != nil {
		return fmt.Errorf("failed to start task push server on worker: %s", err)
	}

	bytesCommitted := int64(0)
	clientCompleted := false

	for {
		bytesRemaining := 0
		if !clientCompleted {
			chunk, err := clientStream.Recv()
			if err != nil {
				if err == io.EOF {
					log.G(t.ctx).Debug("received last push chunk")
					clientCompleted = true
				} else {
					log.G(t.ctx).Debug("received push error", zap.Error(err))
					return fmt.Errorf("failed to receive image chunk from client: %s", err)
				}
			}

			if chunk == nil {
				log.G(t.ctx).Debug("closing worker stream")
				if err := workerStream.CloseSend(); err != nil {
					return fmt.Errorf("failed to send closing frame to worker: %s", err)
				}
			} else {
				bytesRemaining = len(chunk.Chunk)
				if err := workerStream.Send(chunk); err != nil {
					log.G(t.ctx).Debug("failed to send chunk to worker", zap.Error(err))
					return fmt.Errorf("failed to send chunk to worker: %s", err)
				}
				log.G(t.ctx).Debug("sent chunk to worker")
			}
		}

		for {
			progress, err := workerStream.Recv()
			if err != nil {
				if err == io.EOF {
					log.G(t.ctx).Debug("received last chunk from worker")
					if bytesCommitted == meta.fileSize {
						clientStream.SetTrailer(workerStream.Trailer())
						return nil
					} else {
						log.G(t.ctx).Debug("worker closed its stream without committing all bytes")
						return status.Errorf(codes.Aborted, "worker closed its stream without committing all bytes")
					}
				} else {
					log.G(t.ctx).Debug("received error from worker", zap.Error(err))
					return fmt.Errorf("failed to receive meta info from worker: %s", err)
				}
			}

			bytesCommitted += progress.Size
			bytesRemaining -= int(progress.Size)

			if err := clientStream.Send(progress); err != nil {
				log.G(t.ctx).Debug("failed to send meta to client", zap.Error(err))
				return fmt.Errorf("failed to send meta to client: %s", err)
			}

			if bytesRemaining == 0 {
				break
			}
		}
	}
}

func (t *tasksAPI) PullTask(req *pb.PullTaskRequest, srv pb.TaskManagement_PullTaskServer) error {
	ctx := context.Background()
	worker, cc, err := t.remotes.getWorkerClientForDeal(ctx, req.GetDealId())
	if err != nil {
		return err
	}
	defer cc.Close()

	pullClient, err := worker.PullTask(ctx, req)
	if err != nil {
		return fmt.Errorf("failed to start task pull server on worker: %s", err)
	}

	header, err := pullClient.Header()
	if err != nil {
		return fmt.Errorf("failed to receive meta from worker: %s", err)
	}

	err = srv.SetHeader(header)
	if err != nil {
		return fmt.Errorf("failed to set meta for client: %s", err)
	}

	for {
		buffer, err := pullClient.Recv()
		if err == io.EOF {
			return nil
		}

		if err != nil {
			return fmt.Errorf("failed to receive chunk from worker: %s", err)
		}

		if buffer != nil {
			err = srv.Send(buffer)
			if err != nil {
				return fmt.Errorf("failed to send meta to client: %s", err)
			}
		}
	}
}

type streamMeta struct {
	ctx      context.Context
	dealID   string
	fileSize int64
}

func (t *tasksAPI) extractStreamMeta(clientStream pb.TaskManagement_PushTaskServer) (*streamMeta, error) {
	md, ok := metadata.FromIncomingContext(clientStream.Context())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "metadata required")
	}

	dealIDs, ok := md["deal"]
	if !ok || len(dealIDs) == 0 {
		return nil, status.Errorf(codes.InvalidArgument, "`%s` required", "deal")
	}

	sizes, ok := md["size"]
	if !ok || len(sizes) == 0 {
		return nil, status.Errorf(codes.InvalidArgument, "`%s` required", "size")
	}

	ctx := metadata.NewOutgoingContext(context.Background(), metadata.New(map[string]string{
		"deal": dealIDs[0],
		"size": sizes[0],
	}))

	v, _ := strconv.ParseInt(sizes[0], 10, 64)

	return &streamMeta{
		ctx:      ctx,
		dealID:   dealIDs[0],
		fileSize: v,
	}, nil
}

func newTasksAPI(opts *remoteOptions) (pb.TaskManagementServer, error) {
	return &tasksAPI{
		ctx:     opts.ctx,
		remotes: opts,
	}, nil
}
