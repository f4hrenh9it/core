package blockchain

import (
	"net/url"
)

// Config represents SONM blockchain configuration structure that can act as a
// building block for more complex configs.
type Config struct {
	Endpoint          url.URL
	SidechainEndpoint url.URL
}

func (m *Config) UnmarshalYAML(unmarshal func(interface{}) error) error {
	var cfg struct {
		Endpoint          string `yaml:"endpoint"`
		SidechainEndpoint string `yaml:"sidechain_endpoint"`
	}

	if err := unmarshal(&cfg); err != nil {
		return err
	}

	if len(cfg.Endpoint) == 0 {
		cfg.Endpoint = defaultMasterchainEndpoint
	}

	if len(cfg.SidechainEndpoint) == 0 {
		cfg.SidechainEndpoint = defaultSidechainEndpoint
	}

	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return err
	}

	sidechainEndpoint, err := url.Parse(cfg.SidechainEndpoint)
	if err != nil {
		return err
	}

	m.Endpoint = *endpoint
	m.SidechainEndpoint = *sidechainEndpoint

	return nil
}
